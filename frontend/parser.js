/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * parser.js -- turn an AWS Cloud WAN core network policy document into a small,
 * neutral graph model that render.js knows how to draw.
 *
 * DESIGN NOTES for the reader:
 *  - Every field is treated as OPTIONAL. Real-world / hand-edited policies
 *    routinely omit keys, so we never assume a key exists and never throw on a
 *    missing one. `JSON.parse` is done by the CALLER inside a try/catch; here we
 *    only walk an already-parsed object.
 *  - We produce a Cytoscape-shaped model ({ nodes, edges, meta }) but keep the
 *    element `data` generic so you can swap in a different renderer.
 *  - No values are ever put into HTML here. This module only builds data;
 *    render.js is responsible for safe (textContent) display.
 */

// --- small defensive helpers -------------------------------------------------

// Return arr if it is a real array, else []. Keeps every loop below crash-proof.
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Return obj if it is a plain object, else {}.
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// Stable, collision-resistant node id for a segment.
function segId(name) {
  return "seg:" + name;
}

// Stable node id for an edge location (region is unique per edge-location list).
function edgeLocId(region) {
  return "edge:" + region;
}

// Stable node id for a network function group.
function nfgId(name) {
  return "nfg:" + name;
}

/**
 * Parse a policy object into a graph model.
 * @param {unknown} policy - already JSON.parsed policy document (any shape).
 * @returns {{nodes: Array, edges: Array, meta: Object}}
 */
export function parsePolicy(policy) {
  const doc = asObject(policy);

  const core = asObject(doc["core-network-configuration"]);
  const edgeLocations = asArray(core["edge-locations"]);
  const segments = asArray(doc["segments"]);
  const segmentActions = asArray(doc["segment-actions"]);
  const attachmentPolicies = asArray(doc["attachment-policies"]);
  const networkFunctionGroups = asArray(doc["network-function-groups"]);

  const nodes = [];
  const edges = [];

  // Set of known segment names -- used to resolve "*" shares and to skip
  // dangling references to segments that were never declared.
  const segmentNames = [];
  for (const seg of segments) {
    const s = asObject(seg);
    if (typeof s.name === "string" && s.name.length > 0) {
      segmentNames.push(s.name);
    }
  }
  const segmentNameSet = new Set(segmentNames);

  // --- segment nodes ---------------------------------------------------------
  for (const seg of segments) {
    const s = asObject(seg);
    const name = typeof s.name === "string" ? s.name : "(unnamed segment)";
    nodes.push({
      data: {
        id: segId(name),
        kind: "segment",
        label: name,
        name,
        description: typeof s.description === "string" ? s.description : "",
        isolateAttachments: s["isolate-attachments"] === true,
        requireAcceptance: s["require-attachment-acceptance"] === true,
        // A segment listing no edge-locations implicitly spans all of them.
        // We keep the raw list; render.js decides how to show "spans all".
        edgeLocations: asArray(s["edge-locations"]).filter(
          (r) => typeof r === "string"
        ),
      },
    });
  }

  // --- edge-location nodes ---------------------------------------------------
  const edgeLocationRegions = [];
  for (const el of edgeLocations) {
    const e = asObject(el);
    const region = typeof e.location === "string" ? e.location : null;
    if (!region) continue; // an edge-location without a region is meaningless
    edgeLocationRegions.push(region);
    const asn = typeof e.asn === "number" ? e.asn : null;
    nodes.push({
      data: {
        id: edgeLocId(region),
        kind: "edge-location",
        region,
        asn,
        label: asn !== null ? `${region} (ASN ${asn})` : region,
      },
    });
  }

  // --- segment -> edge-location "spans" edges --------------------------------
  // Only drawn when a segment explicitly lists edge-locations. A segment that
  // lists none implicitly spans ALL edge-locations; drawing that as edges would
  // clutter the graph, so we surface it as a note in the model instead.
  for (const node of nodes) {
    if (node.data.kind !== "segment") continue;
    for (const region of node.data.edgeLocations) {
      if (!edgeLocationRegions.includes(region)) continue;
      edges.push({
        data: {
          id: `spans:${node.data.name}:${region}`,
          source: node.data.id,
          target: edgeLocId(region),
          kind: "spans",
        },
      });
    }
  }

  // --- network-function-group nodes ------------------------------------------
  // Service insertion (send-via / send-to) steers traffic THROUGH an NFG. Most
  // policies have none; parse defensively so their absence changes nothing.
  const nfgNames = [];
  for (const g of networkFunctionGroups) {
    const grp = asObject(g);
    if (typeof grp.name === "string" && grp.name.length > 0) {
      nfgNames.push(grp.name);
      nodes.push({
        data: {
          id: nfgId(grp.name),
          kind: "nfg",
          name: grp.name,
          label: grp.name,
          description: typeof grp.description === "string" ? grp.description : "",
          requireAcceptance: grp["require-attachment-acceptance"] === true,
        },
      });
    }
  }

  // --- segment-actions: share + create-route ---------------------------------
  // First pass: collect the raw share-with target set per segment so we can
  // later tell a mutual share from a one-way "leak" (A shares with B, but B
  // does not list A). "*" means "all other segments" -> always bidirectional.
  const shareTargets = {}; // segment name -> Set of target names (or "*")
  for (const action of segmentActions) {
    const a = asObject(action);
    if (a.action !== "share") continue;
    const sourceSeg = typeof a.segment === "string" ? a.segment : null;
    if (!sourceSeg || !segmentNameSet.has(sourceSeg)) continue;

    if (a["share-with"] === "*") {
      shareTargets[sourceSeg] = "*";
      continue;
    }
    const set = shareTargets[sourceSeg] instanceof Set ? shareTargets[sourceSeg] : new Set();
    for (const t of asArray(a["share-with"])) {
      if (typeof t === "string" && segmentNameSet.has(t) && t !== sourceSeg) set.add(t);
    }
    if (shareTargets[sourceSeg] !== "*") shareTargets[sourceSeg] = set;
  }

  // Does `from` share with `to`? "*" matches everything.
  function sharesWith(from, to) {
    const t = shareTargets[from];
    if (t === "*") return true;
    return t instanceof Set && t.has(to);
  }

  // Emit one edge per ordered (source -> target) share so the renderer can draw
  // it typed. `leak` is true when the reverse direction is NOT also shared and
  // neither side used "*" (a genuine asymmetric relationship).
  const emittedShareEdges = new Set();
  for (const sourceSeg of Object.keys(shareTargets)) {
    const targets =
      shareTargets[sourceSeg] === "*"
        ? segmentNames.filter((n) => n !== sourceSeg)
        : Array.from(shareTargets[sourceSeg]);
    for (const target of targets) {
      const key = `${sourceSeg}->${target}`;
      if (emittedShareEdges.has(key)) continue;
      emittedShareEdges.add(key);
      const reverse = sharesWith(target, sourceSeg);
      const wildcard = shareTargets[sourceSeg] === "*" || shareTargets[target] === "*";
      const leak = !reverse && !wildcard;
      edges.push({
        data: {
          id: `share:${sourceSeg}:${target}`,
          source: segId(sourceSeg),
          target: segId(target),
          kind: leak ? "leak" : "share",
          bidirectional: !leak,
        },
      });
    }
  }

  // Second pass: create-route nodes (share handled above).
  let routeSeq = 0;
  for (const action of segmentActions) {
    const a = asObject(action);
    const type = a.action;
    const sourceSeg = typeof a.segment === "string" ? a.segment : null;
    if (!sourceSeg || !segmentNameSet.has(sourceSeg)) continue;

    if (type === "create-route") {
      // Represent a create-route as one small route node linked to its segment,
      // rather than many CIDR labels cluttering the segment node.
      const cidrs = asArray(a["destination-cidr-blocks"]).filter(
        (c) => typeof c === "string"
      );
      // `destinations` may be an array of attachments or the string "blackhole".
      const blackhole =
        a.destinations === "blackhole" ||
        asArray(a.destinations).includes("blackhole");
      const routeNodeId = `route:${sourceSeg}:${routeSeq++}`;
      nodes.push({
        data: {
          id: routeNodeId,
          kind: "route",
          segment: sourceSeg,
          cidrs,
          blackhole,
          label: cidrs.length ? cidrs.join(", ") : "create-route",
        },
      });
      edges.push({
        data: {
          id: `routelink:${routeNodeId}`,
          source: segId(sourceSeg),
          target: routeNodeId,
          kind: "route",
        },
      });
    }
    // Unknown action types are ignored on purpose -- forward compatibility.
  }

  // --- segment-actions: send-via / send-to (service insertion) ---------------
  // send-via = east-west: `segment` <-> each when-sent-to.segments entry, THROUGH
  //            the referenced network-function-group(s).
  // send-to  = north-south: `segment` -> out of the cloud via the NFG(s); there
  //            is no destination segment (toSegment stays null).
  // Shapes vary a lot in the wild, so every access is guarded. An unknown shape
  // simply yields no inspection relationship rather than throwing.
  const inspections = []; // { fromSegment, nfg, toSegment|null, mode }
  const nfgNameSet = new Set(nfgNames);
  for (const action of segmentActions) {
    const a = asObject(action);
    const type = a.action;
    if (type !== "send-via" && type !== "send-to") continue;
    const fromSeg = typeof a.segment === "string" ? a.segment : null;
    if (!fromSeg || !segmentNameSet.has(fromSeg)) continue;

    const via = asObject(a.via);
    const usedNfgs = asArray(via["network-function-groups"]).filter(
      (n) => typeof n === "string" && nfgNameSet.has(n)
    );
    if (usedNfgs.length === 0) continue; // nothing meaningful to draw

    const mode = typeof a.mode === "string" ? a.mode : "";

    if (type === "send-via") {
      const dests = asArray(asObject(a["when-sent-to"]).segments).filter(
        (n) => typeof n === "string" && segmentNameSet.has(n) && n !== fromSeg
      );
      for (const nfg of usedNfgs) {
        for (const toSeg of dests) {
          inspections.push({ fromSegment: fromSeg, nfg, toSegment: toSeg, mode });
        }
      }
    } else {
      // send-to: north-south egress, no destination segment.
      for (const nfg of usedNfgs) {
        inspections.push({ fromSegment: fromSeg, nfg, toSegment: null, mode: "" });
      }
    }
  }

  // --- attachment-policies: index which rules map INTO each segment ----------
  // We do NOT draw these as edges (they describe attachment classification, not
  // segment-to-segment connectivity). Instead we index them by target segment
  // so the side panel can list "rules that place attachments into this segment".
  const rulesBySegment = {};
  for (const rule of attachmentPolicies) {
    const r = asObject(rule);
    const act = asObject(r.action);
    const targetSeg = typeof act.segment === "string" ? act.segment : null;

    const summary = {
      ruleNumber: typeof r["rule-number"] === "number" ? r["rule-number"] : null,
      conditionLogic:
        typeof r["condition-logic"] === "string" ? r["condition-logic"] : "",
      associationMethod:
        typeof act["association-method"] === "string"
          ? act["association-method"]
          : "",
      conditions: asArray(r.conditions).map((c) => {
        const cond = asObject(c);
        return {
          type: typeof cond.type === "string" ? cond.type : "",
          operator: typeof cond.operator === "string" ? cond.operator : "",
          key: typeof cond.key === "string" ? cond.key : "",
          value: typeof cond.value === "string" ? cond.value : "",
        };
      }),
    };

    // association-method "constant" -> a fixed segment name.
    // association-method "tag" -> segment is chosen at runtime from a tag value,
    // so there is no single target segment to index against.
    if (targetSeg && segmentNameSet.has(targetSeg)) {
      (rulesBySegment[targetSeg] ||= []).push(summary);
    }
  }

  // --- meta: header info strip -----------------------------------------------
  const meta = {
    version: typeof doc.version === "string" ? doc.version : "",
    asnRanges: asArray(core["asn-ranges"]).filter((x) => typeof x === "string"),
    vpnEcmpSupport: core["vpn-ecmp-support"] === true,
    edgeLocationCount: edgeLocationRegions.length,
    segmentCount: segmentNames.length,
    networkFunctionGroupCount: nfgNames.length,
    // Ordered region list -- render.js uses this to lay out one column per
    // edge-location, left-to-right, in declaration order.
    edgeLocationRegions,
    // Ordered segment name list -- one full-width lane per segment, top-to-bottom.
    segmentNames,
    nfgNames,
    // Service-insertion relationships (empty for the common no-NFG policy).
    inspections,
    // Segments that span all edge-locations implicitly (declared none).
    segmentsSpanningAll: nodes
      .filter((n) => n.data.kind === "segment" && n.data.edgeLocations.length === 0)
      .map((n) => n.data.name),
    rulesBySegment,
  };

  // --- region -> present segments (for the region-click presence filter) -----
  // Cloud WAN presence rule (implemented exactly): a segment is PRESENT in a
  // region R when it EXPLICITLY lists R in its edge-locations, OR it lists NO
  // edge-locations at all (implicitly spanning every region). A segment that
  // lists edge-locations but not R is NOT present in R.
  //
  // Additive model field: meta.segmentsByRegion maps every declared region to
  // an ordered list of { name, reason } where reason explains WHY it is present
  // ("explicit" = explicitly scoped here; "spans-all" = declares no locations).
  // A region with no matching segments simply gets an empty list -- never a
  // missing key and never a throw. render.js reads this to drive the filter.
  const segmentMeta = nodes.filter((n) => n.data.kind === "segment");
  const spansAllSet = new Set(meta.segmentsSpanningAll);
  const segmentsByRegion = {};
  for (const region of edgeLocationRegions) {
    const present = [];
    for (const n of segmentMeta) {
      const name = n.data.name;
      if (spansAllSet.has(name)) {
        present.push({ name, reason: "spans-all" });
      } else if (n.data.edgeLocations.includes(region)) {
        present.push({ name, reason: "explicit" });
      }
    }
    segmentsByRegion[region] = present;
  }
  meta.segmentsByRegion = segmentsByRegion;

  return { nodes, edges, meta };
}

// ===========================================================================
// ATTACHMENT SIMULATOR -- pure evaluation engine (no DOM, unit-testable)
// ===========================================================================
//
// simulateAttachment(policy, attachment) evaluates a hypothetical attachment
// against a policy's `attachment-policies` EXACTLY the way AWS Cloud WAN does,
// so a network engineer can answer "if I create this attachment, which segment
// does it land in, and which rule decided that?" fully offline.
//
// SEMANTICS -- verified against the AWS docs, "Core network policy version
// parameters" -> "attachment-policies"
// (https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policies-json.html):
//
//  * Rules carry a `rule-number` (1..65535) and are processed in ASCENDING
//    number order. "When a match is made, the action is taken and no further
//    rules are processed." -> FIRST MATCH WINS. A later rule that would also
//    match never overrides an earlier match.
//  * A rule matches when its `conditions` evaluate true under `condition-logic`
//    ("and" = all conditions true, "or" = any true; conditions are unordered
//    and cannot nest). condition-logic is only mandatory with >1 condition.
//  * Condition `type` set (exactly as documented):
//      - "any"            matches every attachment; no operator/value.
//      - "attachment-type" value in {vpc, site-to-site-vpn, connect,
//                          transit-gateway-route-table}.
//      - "region"         the attachment's AWS Region.
//      - "account"        the requesting account ID.
//      - "resource-id"    the attachment's resource id (e.g. vpc-...).
//      - "tag-value"      matches a tag VALUE for the tag key named by `key`.
//      - "tag-name"       matches on PRESENCE of the tag key named by `key`
//                          (no value comparison). We also accept the alias
//                          "tag-exists" that appears in the NFG doc example.
//    Value-bearing types use `operator` in {equals, not-equals, contains,
//    begins-with}. (The docs list ONLY these four -- there is deliberately no
//    "ends-with".) An unknown/absent operator on a value type is treated as a
//    non-match rather than throwing.
//  * Association (rule `action`):
//      - association-method "constant" -> action.segment (must be a declared
//        segment; if it names an undeclared segment we report invalid).
//      - association-method "tag" -> action.tag-value-of-key names a tag KEY on
//        the ATTACHMENT; that tag's VALUE must exactly equal a declared segment
//        name. If the tag is absent, or its value is not a declared segment,
//        there is NO association (we do NOT force a match) -- mirroring the doc
//        note that a misspelled tag value leaves the attachment unassociated.
//      - action.add-to-network-function-group -> service-insertion assignment,
//        NOT a segment association; we report it as such (segment stays null).
//  * Acceptance: a segment requires acceptance by default; the segment's
//    `require-attachment-acceptance:false` turns it off; a matched rule's
//    `action.require-acceptance:true` overrides back to requiring acceptance.
//  * There is NO CIDR condition type. Association is decided by
//    type/region/account/tags/resource-id only, so `cidr` is captured for
//    display but never participates in matching.
//
// Every access is defensive: missing/malformed sections yield a clean
// "no association" result, never a throw.

// Apply a documented operator to two strings. Returns false for any operator
// the docs do not define, so an unknown operator can never accidentally match.
function applyOperator(operator, actual, expected) {
  const a = typeof actual === "string" ? actual : "";
  const e = typeof expected === "string" ? expected : "";
  switch (operator) {
    case "equals":
      return a === e;
    case "not-equals":
      return a !== e;
    case "contains":
      return e.length > 0 && a.includes(e);
    case "begins-with":
      return e.length > 0 && a.startsWith(e);
    default:
      return false; // undocumented / missing operator -> never matches
  }
}

// Evaluate ONE condition against the attachment. Returns { matched, why } where
// `why` is a short human-readable explanation for the trace. Pure + defensive.
function evaluateCondition(condition, attachment) {
  const c = asObject(condition);
  const type = typeof c.type === "string" ? c.type : "";
  const operator = typeof c.operator === "string" ? c.operator : "";
  const key = typeof c.key === "string" ? c.key : "";
  const value = typeof c.value === "string" ? c.value : "";
  const tags = asObject(attachment.tags);

  switch (type) {
    case "any":
      return { matched: true, why: "any -> matches every attachment" };

    case "attachment-type": {
      const ok = applyOperator(operator, attachment.attachmentType, value);
      return {
        matched: ok,
        why: `attachment-type ${operator} "${value}" vs "${attachment.attachmentType || ""}" -> ${ok}`,
      };
    }

    case "region": {
      const ok = applyOperator(operator, attachment.region, value);
      return {
        matched: ok,
        why: `region ${operator} "${value}" vs "${attachment.region || ""}" -> ${ok}`,
      };
    }

    case "account": {
      const ok = applyOperator(operator, attachment.accountId, value);
      return {
        matched: ok,
        why: `account ${operator} "${value}" vs "${attachment.accountId || ""}" -> ${ok}`,
      };
    }

    case "resource-id": {
      const ok = applyOperator(operator, attachment.resourceId, value);
      return {
        matched: ok,
        why: `resource-id ${operator} "${value}" vs "${attachment.resourceId || ""}" -> ${ok}`,
      };
    }

    case "tag-value": {
      // The tag KEY is carried in `key`; we compare that tag's VALUE.
      const actual = typeof tags[key] === "string" ? tags[key] : "";
      const present = Object.prototype.hasOwnProperty.call(tags, key);
      if (!present) {
        return { matched: false, why: `tag-value: tag "${key}" not present -> false` };
      }
      const ok = applyOperator(operator, actual, value);
      return {
        matched: ok,
        why: `tag-value key="${key}" ${operator} "${value}" vs "${actual}" -> ${ok}`,
      };
    }

    case "tag-name":
    case "tag-exists": {
      // Presence of the tag key only -- no value comparison.
      const ok = Object.prototype.hasOwnProperty.call(tags, key);
      return { matched: ok, why: `${type} "${key}" present -> ${ok}` };
    }

    default:
      // Unknown condition type: cannot be satisfied, but never throws.
      return { matched: false, why: `unknown condition type "${type}" -> false` };
  }
}

// Evaluate ALL of a rule's conditions under its condition-logic. With a single
// condition, condition-logic is irrelevant (doc: mandatory only for >1).
function evaluateRuleConditions(conditions, logic, attachment) {
  const results = conditions.map((cond) => evaluateCondition(cond, attachment));
  if (results.length === 0) {
    // A rule with no conditions: Cloud WAN requires at least one, so treat an
    // empty condition set as a non-match rather than a silent match-all.
    return { matched: false, results, note: "rule has no conditions -> no match" };
  }
  const useOr = logic === "or";
  const matched = useOr
    ? results.some((r) => r.matched)
    : results.every((r) => r.matched);
  return { matched, results, note: "" };
}

/**
 * Simulate one hypothetical attachment against a policy's attachment-policies.
 *
 * @param {unknown} policy - already JSON.parsed policy document (any shape).
 * @param {Object} attachment - {
 *     attachmentType, region, accountId, resourceId,
 *     tags: {key: value}, cidr
 *   } (every field optional; strings expected).
 * @returns {{
 *   associatedSegment: string|null,
 *   matchedRule: number|null,
 *   reason: string,
 *   evaluated: Array<{ruleNumber:number|null, matched:boolean, why:string}>,
 *   acceptanceRequired: boolean,
 *   notes: Array<string>
 * }}
 */
export function simulateAttachment(policy, attachment) {
  const doc = asObject(policy);
  const att = asObject(attachment);
  const notes = [];

  // Declared segments, and each segment's own require-attachment-acceptance.
  // Default acceptance is TRUE per the docs ("every segment requires all
  // attachments to be accepted" unless explicitly turned off).
  const segments = asArray(doc["segments"]);
  const segmentAcceptance = {}; // name -> bool (segment-level requirement)
  const segmentNameSet = new Set();
  for (const seg of segments) {
    const s = asObject(seg);
    if (typeof s.name === "string" && s.name.length > 0) {
      segmentNameSet.add(s.name);
      // Default true; only an explicit `false` turns acceptance off.
      segmentAcceptance[s.name] = s["require-attachment-acceptance"] !== false;
    }
  }

  // Sort rules by ascending rule-number. Rules missing a numeric rule-number
  // sort last (Cloud WAN requires the number, but we stay defensive) and keep
  // their original relative order via a stable index tiebreak.
  const rules = asArray(doc["attachment-policies"]).map((r, i) => ({
    raw: asObject(r),
    seq: i,
  }));
  rules.sort((x, y) => {
    const nx = typeof x.raw["rule-number"] === "number" ? x.raw["rule-number"] : Infinity;
    const ny = typeof y.raw["rule-number"] === "number" ? y.raw["rule-number"] : Infinity;
    if (nx !== ny) return nx - ny;
    return x.seq - y.seq;
  });

  const evaluated = [];

  for (const { raw } of rules) {
    const ruleNumber =
      typeof raw["rule-number"] === "number" ? raw["rule-number"] : null;
    const logic = typeof raw["condition-logic"] === "string" ? raw["condition-logic"] : "";
    const conditions = asArray(raw.conditions);
    const { matched, results, note } = evaluateRuleConditions(conditions, logic, att);

    // Build a compact "why" for this rule's line in the trace.
    const condSummaries = results.map((r) => r.why);
    const logicWord = conditions.length > 1 ? (logic === "or" ? " OR " : " AND ") : "";
    const why =
      results.length === 0
        ? note || "no conditions"
        : condSummaries.join(logicWord || "; ");

    evaluated.push({ ruleNumber, matched, why });

    if (!matched) continue;

    // --- first matching rule wins: resolve its action -----------------------
    const action = asObject(raw.action);
    const method =
      typeof action["association-method"] === "string"
        ? action["association-method"]
        : "";

    // Service-insertion assignment is not a segment association.
    if (typeof action["add-to-network-function-group"] === "string" && !method) {
      return {
        associatedSegment: null,
        matchedRule: ruleNumber,
        reason:
          `Rule #${ruleNumber} matched and assigns the attachment to network ` +
          `function group "${action["add-to-network-function-group"]}" ` +
          `(service insertion) -- this is not a segment association.`,
        evaluated,
        acceptanceRequired: action["require-acceptance"] === true,
        notes,
      };
    }

    let segment = null;
    let reason = "";

    if (method === "tag") {
      // Dynamic association: the attachment's tag named by tag-value-of-key
      // supplies the segment name, which must exactly match a declared segment.
      const tagKey =
        typeof action["tag-value-of-key"] === "string" ? action["tag-value-of-key"] : "";
      const tags = asObject(att.tags);
      const present = Object.prototype.hasOwnProperty.call(tags, tagKey);
      const tagValue = present && typeof tags[tagKey] === "string" ? tags[tagKey] : "";
      if (!present) {
        reason =
          `Rule #${ruleNumber} matched (association-method=tag) but the ` +
          `attachment has no "${tagKey}" tag -> NO association.`;
      } else if (!segmentNameSet.has(tagValue)) {
        reason =
          `Rule #${ruleNumber} matched (association-method=tag): tag ` +
          `"${tagKey}"="${tagValue}" does not name a declared segment -> NO association.`;
      } else {
        segment = tagValue;
        reason =
          `Rule #${ruleNumber} matched (association-method=tag): tag ` +
          `"${tagKey}"="${tagValue}" -> segment "${segment}".`;
      }
    } else {
      // "constant" (or an omitted method defaulting to a fixed segment).
      const target = typeof action.segment === "string" ? action.segment : "";
      if (!target) {
        reason = `Rule #${ruleNumber} matched but declares no segment -> NO association.`;
      } else if (!segmentNameSet.has(target)) {
        reason =
          `Rule #${ruleNumber} matched (association-method=constant) but ` +
          `segment "${target}" is not declared -> NO association (invalid).`;
      } else {
        segment = target;
        reason = `Rule #${ruleNumber} matched -> segment "${segment}" (constant).`;
      }
    }

    // Acceptance: segment-level default, overridden to true by the rule's
    // require-acceptance. Only meaningful when we actually associated a segment.
    let acceptanceRequired = false;
    if (segment) {
      acceptanceRequired = segmentAcceptance[segment] === true;
      if (action["require-acceptance"] === true) {
        acceptanceRequired = true;
        notes.push(
          `Rule #${ruleNumber} sets require-acceptance:true (overrides the ` +
            `segment's own setting).`
        );
      }
    }

    return {
      associatedSegment: segment,
      matchedRule: ruleNumber,
      reason,
      evaluated,
      acceptanceRequired,
      notes,
    };
  }

  // No rule matched -> per the docs, the attachment is not associated.
  return {
    associatedSegment: null,
    matchedRule: null,
    reason:
      "No attachment-policy rule matched -> the attachment would NOT be " +
      "associated with any segment.",
    evaluated,
    acceptanceRequired: false,
    notes,
  };
}

// ===========================================================================
// REACHABILITY / PATH CHECKER -- pure evaluation engine (no DOM, unit-testable)
// ===========================================================================
//
// checkReachability(policy, source, destination) answers, at the POLICY layer,
// "does this policy permit + route traffic from segment SOURCE to DESTINATION
// (another segment, or the internet)?" fully offline. It is the reachability
// analogue of simulateAttachment: a network engineer picks two endpoints and
// gets a verdict + the hop-by-hop path the policy would build, with the policy
// reason for each hop.
//
// SEMANTICS -- verified against the AWS docs, "Core network policy version
// parameters" -> "segments" + "segment-actions"
// (https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policies-json.html):
//
//  * BASELINE ISOLATION. "Each segment is created and operates as a completely
//    separate routing domain. By default, attachments can only communicate
//    with other attachments in the same segment." So two segments are NOT
//    reachable to each other unless a segment-action connects them.
//
//  * share ESTABLISHES SEGMENT-TO-SEGMENT REACHABILITY. "Use the share action
//    so that attachments from two different segments can reach each other."
//    When `share-with` is an ARRAY, only the defined `segment` reaches each
//    array entry -- the array entries do NOT reach each other ("A and B cannot
//    reach each other"). "*" is a wildcard for all other segments.
//    The AWS docs describe share as creating "mutual advertisements", i.e. a
//    fully-declared share is bidirectional. This engine implements DIRECTIONAL
//    semantics on top of the parser's own share/leak model so a network
//    engineer can reason about an ASYMMETRIC (one-way "leak") relationship:
//      - A `share` edge (parser kind "share") = BOTH directions reachable
//        (mutual: A lists B AND B lists A, or a "*" wildcard on either side).
//      - A `leak` edge (parser kind "leak") = ONE direction only, from the
//        edge SOURCE to the edge TARGET (A lists B in share-with, but B does
//        NOT list A). The reverse direction is NOT reachable. This mirrors a
//        real misconfiguration where sharing was declared on only one side.
//    We build a DIRECTED adjacency from these edges and do a breadth-first
//    search, so multi-hop transit (A->B->C where each hop is separately
//    shared) is found and reported hop by hop.
//
//  * isolate-attachments DOES NOT BLOCK INTER-SEGMENT REACHABILITY. The doc is
//    explicit: it "determines whether attachments on the SAME segment can
//    communicate with each other", and when true "the only routes available
//    will either be shared routes through the share actions ... or static
//    routes." So an isolated segment can STILL reach another segment it shares
//    with; isolate-attachments only removes intra-segment attachment-to-
//    attachment routes. It therefore never blocks an inter-segment path here.
//    (Intra-segment attachment-to-attachment reachability is a FUTURE feature;
//    this engine models segment-to-segment + segment-to-internet only.)
//
//  * send-via = EAST-WEST INSPECTION. Traffic between `segment` and each
//    when-sent-to.segments entry is steered THROUGH the network-function-group.
//    When an inspection relationship covers the source->destination pair, the
//    path MUST traverse the NFG: source -> nfg -> destination.
//
//  * send-to = NORTH-SOUTH EGRESS through an NFG. "traffic that first must come
//    into your security appliance and then out to either the Internet or an
//    on-premises location." So a segment with a send-to gets internet egress,
//    but INSPECTED -- the egress path is source -> nfg -> internet.
//
//  * create-route 0.0.0.0/0 (or ::/0) = INTERNET EGRESS. A default static route
//    in a segment sends its unmatched traffic out; we treat a default-route
//    create-route as (uninspected) internet egress: source -> internet. A
//    non-default create-route (a specific prefix) is NOT internet egress.
//
// EVERYTHING IS POLICY-INTENT ONLY. A "reachable" verdict means the policy
// PERMITS + ROUTES the traffic; it is NOT a live data-plane guarantee (the real
// propagated/effective route tables live only at runtime via Network Manager
// APIs). Every result says so in `notes`.
//
// Defensive: unknown/missing segment names, malformed sections, or a null
// policy all yield { reachable:false, ... } with a clear reason -- never a throw.

const INTERNET = "internet";

// Is a CIDR string a default route (all-zeros v4 or v6)? Only a default route
// grants blanket internet egress; a specific prefix does not.
function isDefaultRoute(cidr) {
  if (typeof cidr !== "string") return false;
  const c = cidr.trim();
  return c === "0.0.0.0/0" || c === "::/0";
}

/**
 * Build the directed reachability model once, then answer a source/destination
 * query against it. Pure + defensive; safe to call with any input shape.
 *
 * @param {unknown} policy - already JSON.parsed policy document (any shape).
 * @param {string} source - source segment name.
 * @param {string} destination - destination segment name, or "internet".
 * @returns {{
 *   reachable: boolean,
 *   path: Array<{hop:string, kind:"segment"|"nfg"|"internet", reason:string}>,
 *   blockedReason: string|null,
 *   notes: Array<string>
 * }}
 */
export function checkReachability(policy, source, destination) {
  const notes = [
    "POLICY-INTENT reachability: this reflects what the policy PERMITS and " +
      "ROUTES, not a live data-plane guarantee. Effective routes exist only at " +
      "runtime via Network Manager (get-network-routes).",
  ];

  const doc = asObject(policy);
  const src = typeof source === "string" ? source : "";
  const dst = typeof destination === "string" ? destination : "";

  // --- declared segments -----------------------------------------------------
  const segmentNameSet = new Set();
  for (const seg of asArray(doc["segments"])) {
    const s = asObject(seg);
    if (typeof s.name === "string" && s.name.length > 0) segmentNameSet.add(s.name);
  }

  // Defensive endpoint validation -- unknown names never throw.
  if (!segmentNameSet.has(src)) {
    return {
      reachable: false,
      path: [],
      blockedReason: `Source segment "${src}" is not a declared segment.`,
      notes,
    };
  }
  const toInternet = dst === INTERNET;
  if (!toInternet && !segmentNameSet.has(dst)) {
    return {
      reachable: false,
      path: [],
      blockedReason: `Destination "${dst}" is neither a declared segment nor "internet".`,
      notes,
    };
  }
  if (!toInternet && src === dst) {
    // Same-segment reachability is an intra-segment attachment concern (subject
    // to isolate-attachments), which is out of scope here (FUTURE). We report a
    // trivially-true single-hop path and flag the caveat rather than pretend to
    // model attachment-to-attachment behaviour.
    return {
      reachable: true,
      path: [{ hop: src, kind: "segment", reason: "source and destination are the same segment" }],
      blockedReason: null,
      notes: notes.concat(
        "Same-segment attachment-to-attachment reachability depends on " +
          "isolate-attachments and is not modelled here (segment-to-segment only)."
      ),
    };
  }

  // --- NFG names --------------------------------------------------------------
  const nfgNameSet = new Set();
  for (const g of asArray(doc["network-function-groups"])) {
    const grp = asObject(g);
    if (typeof grp.name === "string" && grp.name.length > 0) nfgNameSet.add(grp.name);
  }

  // --- directed share adjacency (share = both ways, leak = one way) ----------
  // First collect each segment's raw share-with target set, exactly as parser
  // parsePolicy does, so the reachability model and the drawn graph agree on
  // which relationships are mutual vs one-way.
  const shareTargets = {}; // name -> Set | "*"
  for (const action of asArray(doc["segment-actions"])) {
    const a = asObject(action);
    if (a.action !== "share") continue;
    const from = typeof a.segment === "string" ? a.segment : null;
    if (!from || !segmentNameSet.has(from)) continue;
    if (a["share-with"] === "*") {
      shareTargets[from] = "*";
      continue;
    }
    const set = shareTargets[from] instanceof Set ? shareTargets[from] : new Set();
    for (const t of asArray(a["share-with"])) {
      if (typeof t === "string" && segmentNameSet.has(t) && t !== from) set.add(t);
    }
    if (shareTargets[from] !== "*") shareTargets[from] = set;
  }
  const allSegments = Array.from(segmentNameSet);
  function listsInShareWith(from, to) {
    const t = shareTargets[from];
    if (t === "*") return true;
    return t instanceof Set && t.has(to);
  }

  // Build a DIRECTED adjacency map: from -> Map(to -> reasonString). A pair that
  // both list each other (or where either uses "*") is mutual, so we add both
  // directions and label them "share (bidirectional)". A pair where only `from`
  // lists `to` is a one-way leak: we add ONLY from->to, labelled as a leak, and
  // deliberately do NOT add to->from -- that is the directional proof.
  const adj = new Map(); // from -> Map(to -> reason)
  function addEdge(from, to, reason) {
    if (!adj.has(from)) adj.set(from, new Map());
    // First reason wins for a given (from,to) -- keeps BFS output stable.
    if (!adj.get(from).has(to)) adj.get(from).set(to, reason);
  }
  for (const from of allSegments) {
    // Resolve this segment's concrete target list ("*" expands to all others).
    const targets =
      shareTargets[from] === "*"
        ? allSegments.filter((n) => n !== from)
        : shareTargets[from] instanceof Set
          ? Array.from(shareTargets[from])
          : [];
    for (const to of targets) {
      const reverse = listsInShareWith(to, from);
      const wildcard = shareTargets[from] === "*" || shareTargets[to] === "*";
      if (reverse || wildcard) {
        // Mutual share -> both directions reachable.
        addEdge(from, to, `share (bidirectional) between "${from}" and "${to}"`);
        addEdge(to, from, `share (bidirectional) between "${to}" and "${from}"`);
      } else {
        // One-way leak -> only from -> to. The reverse stays unreachable unless
        // some OTHER action supplies it.
        addEdge(
          from,
          to,
          `one-way share leak: "${from}" lists "${to}" in share-with but "${to}" does not list "${from}"`
        );
      }
    }
  }

  // --- inspection (send-via) relationships, directional ----------------------
  // inspectionBetween.get(a+"\u0000"+b) = nfg name if traffic a->b is inspected.
  // send-via is symmetric between `segment` and each when-sent-to segment, so we
  // record both orientations. send-to (egress) is handled separately below.
  const inspectionBetween = new Map();
  const egressBySegment = new Map(); // segment -> { nfg|null, reason }
  for (const action of asArray(doc["segment-actions"])) {
    const a = asObject(action);
    const type = a.action;
    if (type !== "send-via" && type !== "send-to") continue;
    const from = typeof a.segment === "string" ? a.segment : null;
    if (!from || !segmentNameSet.has(from)) continue;
    const via = asObject(a.via);
    const usedNfgs = asArray(via["network-function-groups"]).filter(
      (n) => typeof n === "string" && nfgNameSet.has(n)
    );
    if (usedNfgs.length === 0) continue;
    const nfg = usedNfgs[0]; // first NFG represents the inspection hop

    if (type === "send-via") {
      const dests = asArray(asObject(a["when-sent-to"]).segments).filter(
        (n) => typeof n === "string" && segmentNameSet.has(n) && n !== from
      );
      for (const to of dests) {
        inspectionBetween.set(from + "\u0000" + to, nfg);
        inspectionBetween.set(to + "\u0000" + from, nfg);
      }
    } else {
      // send-to: north-south egress THROUGH the NFG (inspected internet egress).
      egressBySegment.set(from, {
        nfg,
        reason: `send-to egress via NFG "${nfg}" (north-south, inspected)`,
      });
    }
  }

  // --- create-route default-route egress (uninspected) -----------------------
  // A segment with a create-route to 0.0.0.0/0 (or ::/0) has blanket internet
  // egress. An inspected (send-to) egress takes precedence in the path label if
  // both exist, but either grants egress.
  for (const action of asArray(doc["segment-actions"])) {
    const a = asObject(action);
    if (a.action !== "create-route") continue;
    const from = typeof a.segment === "string" ? a.segment : null;
    if (!from || !segmentNameSet.has(from)) continue;
    const cidrs = asArray(a["destination-cidr-blocks"]).filter((c) => typeof c === "string");
    const blackhole =
      a.destinations === "blackhole" || asArray(a.destinations).includes("blackhole");
    if (blackhole) continue; // a blackhole default route drops traffic, no egress
    if (cidrs.some(isDefaultRoute) && !egressBySegment.has(from)) {
      egressBySegment.set(from, {
        nfg: null,
        reason: "create-route default (0.0.0.0/0) -> internet egress",
      });
    }
  }

  // Helper: does an inspection apply to the a->b hop? Returns nfg name or null.
  function inspectionFor(a, b) {
    return inspectionBetween.get(a + "\u0000" + b) || null;
  }

  // ==========================================================================
  // SEGMENT -> INTERNET
  // ==========================================================================
  if (toInternet) {
    // Reachable if the source, OR any segment the source can transit to, has an
    // egress (send-to or default create-route). BFS the directed share graph;
    // the first egress-bearing segment we reach defines the egress hop.
    const { order, prev } = bfs(adj, src);
    for (const seg of order) {
      const egress = egressBySegment.get(seg);
      if (!egress) continue;
      // Build the segment path src -> ... -> seg, then append the egress hop(s).
      const segPath = reconstruct(prev, src, seg, adj);
      const path = segPath.slice();
      if (egress.nfg) {
        path.push({ hop: egress.nfg, kind: "nfg", reason: egress.reason });
      }
      path.push({
        hop: INTERNET,
        kind: "internet",
        reason: egress.nfg
          ? `internet egress through NFG "${egress.nfg}"`
          : egress.reason,
      });
      return { reachable: true, path, blockedReason: null, notes };
    }
    return {
      reachable: false,
      path: [],
      blockedReason:
        `No egress found: "${src}" has no send-to or default (0.0.0.0/0) ` +
        `create-route, and no segment reachable from it does.`,
      notes,
    };
  }

  // ==========================================================================
  // SEGMENT -> SEGMENT
  // ==========================================================================
  const { prev, seen } = bfs(adj, src);
  if (!seen.has(dst)) {
    return {
      reachable: false,
      path: [],
      blockedReason:
        `No policy path from "${src}" to "${dst}": they are not shared ` +
        `(directly or transitively) in the "${src}" -> "${dst}" direction.`,
      notes,
    };
  }
  // Reconstruct the segment hop path, then inject NFG hops where an inspection
  // applies to a consecutive segment pair (send-via forces traffic through it).
  const segPath = reconstruct(prev, src, dst, adj);
  const path = [];
  for (let i = 0; i < segPath.length; i++) {
    path.push(segPath[i]);
    if (i < segPath.length - 1) {
      const a = segPath[i].hop;
      const b = segPath[i + 1].hop;
      const nfg = inspectionFor(a, b);
      if (nfg) {
        path.push({
          hop: nfg,
          kind: "nfg",
          reason: `inspected via send-via NFG "${nfg}" between "${a}" and "${b}"`,
        });
      }
    }
  }
  return { reachable: true, path, blockedReason: null, notes };
}

// ===========================================================================
// LIVE ROUTES (DATA-PLANE) -- normalize + data-plane reachability
//
// The functions above answer "what does the POLICY intend?" using only the
// policy document. The two below answer "what do the DEPLOYED routes actually
// permit?" using the JSON returned by `aws networkmanager get-network-routes`.
// They are pure and defensive (never throw on odd input), exactly like the
// policy-intent engine, so the UI can show both verdicts side by side and label
// which is which.
// ===========================================================================

/**
 * Normalize a raw get-network-routes response into a flat, safe route list.
 *
 * The AWS shape is `{ "NetworkRoutes": [ { "DestinationCidrBlock": "..",
 * "State": "ACTIVE|BLACKHOLE", "Type": "PROPAGATED|STATIC",
 * "Destinations": [ { "SegmentName": ".." , ... } ] }, ... ] }`. The API
 * returns State/Type in UPPERCASE; we store `state` as returned (so the UI
 * shows the API's own casing) and callers compare it case-insensitively. We
 * defend against every field being missing or the wrong type -- a malformed or
 * empty response yields an empty list, never a throw.
 *
 * @param {unknown} routesJson - already JSON.parsed get-network-routes output.
 * @returns {Array<{cidr:string, state:string, type:string, segments:string[]}>}
 */
export function normalizeLiveRoutes(routesJson) {
  const doc = asObject(routesJson);
  const out = [];
  for (const r of asArray(doc["NetworkRoutes"])) {
    const route = asObject(r);
    const cidr =
      typeof route["DestinationCidrBlock"] === "string" ? route["DestinationCidrBlock"] : "";
    const state = typeof route["State"] === "string" ? route["State"] : "";
    const type = typeof route["Type"] === "string" ? route["Type"] : "";
    const segments = [];
    for (const d of asArray(route["Destinations"])) {
      const dest = asObject(d);
      // Only a Destinations[].SegmentName is a segment NAME. We deliberately do
      // NOT fall back to CoreNetworkAttachmentId here: downstream,
      // checkDataPlaneReachability matches this list against a segment name via
      // `.includes(destination)`, and an attachment id can never equal a
      // segment name -- so pushing one in was pure noise that could never match.
      const seg = typeof dest["SegmentName"] === "string" ? dest["SegmentName"] : "";
      if (seg) segments.push(seg);
    }
    out.push({ cidr, state, type, segments });
  }
  return out;
}

/**
 * Normalize a route's State for comparison. The AWS GetNetworkRoutes API
 * returns State in UPPERCASE ("ACTIVE" / "BLACKHOLE"), so we MUST compare
 * case-insensitively -- an "ACTIVE" route compared against the literal
 * "active" would otherwise be misread as inactive and the reachability verdict
 * would wrongly report the traffic as dropped. A missing/non-string state
 * normalizes to "" (which is never "active"), so an unknown state is treated as
 * not-active without throwing.
 * @param {object} r - a normalized route.
 * @returns {string} lowercased state, or "" if absent.
 */
function stateOf(r) {
  return String((r && r.state) || "").toLowerCase();
}

/**
 * Human-readable state for messages: the route's raw state if present (kept in
 * the API's own casing so the UI matches what the console shows), else the
 * explicit word "unknown" so a missing state reads clearly.
 * @param {object} r - a normalized route.
 * @returns {string}
 */
function stateLabel(r) {
  return (r && typeof r.state === "string" && r.state) || "unknown";
}

/**
 * DATA-PLANE reachability: does the DEPLOYED route table actually carry a route
 * that would move traffic from `source` toward `destination`?
 *
 * This is intentionally simpler and more literal than the policy-intent engine:
 * it does not reason about share/leak semantics, it just reads what routes are
 * installed. A route is "usable" only if its State is ACTIVE (compared
 * case-insensitively, since the API returns UPPERCASE); a blackhole (or
 * otherwise inactive/unknown) route is reported as an explicit DROP, which is
 * the whole point of overlaying live data -- a policy can INTEND connectivity
 * while the deployed table blackholes it.
 *
 * @param {Array} liveRoutes - output of normalizeLiveRoutes().
 * @param {string} source - source segment name (for labelling only).
 * @param {string} destination - destination segment name, or "internet".
 * @returns {{
 *   reachable: boolean,
 *   routes: Array<{cidr:string, state:string, type:string, segments:string[]}>,
 *   blackholed: Array<object>,
 *   blockedReason: string|null,
 *   notes: string[]
 * }}
 */
export function checkDataPlaneReachability(liveRoutes, source, destination) {
  const notes = [
    "DEPLOYED-ROUTES reachability: this reflects the ACTUAL route table pulled " +
      "live from Network Manager (get-network-routes), not policy intent. A " +
      "blackholed or missing route drops traffic even if the policy permits it.",
  ];
  const routes = Array.isArray(liveRoutes) ? liveRoutes : [];
  const toInternet = destination === INTERNET;

  // Which routes point AT the destination? For a segment destination we match
  // the segment name; for the internet we match a default route (0.0.0.0/0).
  const matching = routes.filter((r) => {
    if (toInternet) return isDefaultRoute(r.cidr);
    return Array.isArray(r.segments) && r.segments.includes(destination);
  });

  if (matching.length === 0) {
    return {
      reachable: false,
      routes: [],
      blackholed: [],
      blockedReason: toInternet
        ? "No default (0.0.0.0/0) route is installed in the deployed table."
        : `No deployed route targets segment "${destination}".`,
      notes,
    };
  }

  const active = matching.filter((r) => stateOf(r) === "active");
  const blackholed = matching.filter((r) => stateOf(r) !== "active");

  if (active.length === 0) {
    return {
      reachable: false,
      routes: [],
      blackholed,
      blockedReason:
        `Route(s) to ${toInternet ? "the Internet" : `"${destination}"`} exist but are ` +
        `NOT active (state: ${blackholed.map((r) => stateLabel(r)).join(", ")}). ` +
        `Traffic is dropped despite the policy.`,
      notes,
    };
  }

  return {
    reachable: true,
    routes: active,
    blackholed,
    blockedReason: null,
    notes,
  };
}

// Breadth-first search over the directed adjacency. Returns discovery order,
// the predecessor map for path reconstruction, and the seen set. Pure helper.
function bfs(adj, start) {
  const seen = new Set([start]);
  const prev = new Map(); // node -> predecessor
  const order = [start];
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    const neighbours = adj.get(cur);
    if (!neighbours) continue;
    for (const next of neighbours.keys()) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      order.push(next);
      queue.push(next);
    }
  }
  return { order, prev, seen };
}

// Reconstruct a segment-hop path start..target from a BFS predecessor map,
// attaching the per-edge share/leak reason to each non-source hop. `adj` is
// used to look up the reason of the edge that entered each hop.
function reconstruct(prev, start, target, adj) {
  const names = [];
  let cur = target;
  while (cur !== undefined) {
    names.push(cur);
    if (cur === start) break;
    cur = prev.get(cur);
  }
  names.reverse();
  const path = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (i === 0) {
      path.push({ hop: name, kind: "segment", reason: "source segment" });
    } else {
      const from = names[i - 1];
      const reason = (adj.get(from) && adj.get(from).get(name)) || "shared";
      path.push({ hop: name, kind: "segment", reason });
    }
  }
  return path;
}

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
 * app.js -- wires the UI (buttons, file picker, paste box) to parser.js and
 * render.js. All JSON parsing happens here, in try/catch, so a malformed
 * document produces a friendly banner instead of an unhandled throw.
 */
import { parsePolicy, simulateAttachment, checkReachability, checkDataPlaneReachability } from "./parser.js";
import {
  renderGraph,
  renderInfoStrip,
  closeSidePanel,
  showSimulatedAttachment,
  clearSimulatedAttachment,
  highlightReachabilityPath,
  clearReachabilityPath,
  clearGraph,
} from "./render.js";
import { EXAMPLE_POLICY } from "./example.js";

const errorBanner = document.getElementById("error-banner");

// The most recently rendered model + the raw policy object behind it. The
// attachment simulator reads both: the policy for evaluation, the model for
// region/segment geometry when drawing the simulated node.
let currentModel = null;
let currentPolicy = null;

// --- mode routing ------------------------------------------------------------
// The whole UI is a tiny state machine driven by ONE attribute: body[data-mode]
// is "landing", "offline", or "live". CSS keys off it to show the landing
// screen, the app shell, and the per-mode control groups (see style.css,
// "MODE ROUTING"). No router or framework -- just this attribute plus setMode().
//
// Control-group scoping is done entirely in CSS by data-mode, so there is one
// obvious place that proves a live user never sees the file/paste/example
// controls and an offline user never sees the AWS controls:
//   [data-mode="live"]    #offline-controls { display: none; }
//   [data-mode="offline"] #live-controls    { display: none; }
// This function only flips the attribute and clears cross-mode state.

const body = document.body;

// Clear the drawn graph + any open panels/selection so state from one mode
// never leaks into the other when switching. Also drops any live-routes overlay
// (belt-and-braces; live.js clears it too on leaving live mode).
function resetVisualization() {
  currentModel = null;
  currentPolicy = null;
  closeSidePanel();
  clearError();
  clearSimResult();
  clearReachResult();
  // Hide the transient panels so a switched mode starts clean.
  document.getElementById("paste-panel").hidden = true;
  document.getElementById("sim-panel").hidden = true;
  document.getElementById("reach-panel").hidden = true;
  document.getElementById("info-strip").hidden = true;
  // Tear down the Cytoscape instance if one was drawn.
  clearGraph();
  if (typeof window.__clearLiveRoutes === "function") window.__clearLiveRoutes();
}

// Switch between "landing", "offline", and "live". Always clears the current
// visualization first so no graph/selection carries across the switch.
function setMode(mode) {
  resetVisualization();
  body.setAttribute("data-mode", mode);
  if (mode === "offline") {
    // Offline is never a blank page: seed the built-in example.
    visualize(EXAMPLE_POLICY);
    if (typeof window.__onLeaveLive === "function") window.__onLeaveLive();
  } else if (mode === "live") {
    // live.js populates its own controls / profile list on entry.
    if (typeof window.__onEnterLive === "function") window.__onEnterLive();
  }
}
// Exposed so live.js can return to the offline/landing states through the same
// single entry point rather than poking the attribute itself.
window.__setMode = setMode;

function showError(message) {
  errorBanner.textContent = message; // textContent -> safe even if message
  errorBanner.hidden = false;         //                echoes policy content
}

function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = "";
}

// Take an already-parsed policy object, build the model, draw it.
function visualize(policyObject) {
  clearError();
  closeSidePanel();
  try {
    const model = parsePolicy(policyObject);
    if (model.meta.segmentCount === 0 && model.meta.edgeLocationCount === 0) {
      showError(
        "Parsed successfully, but found no segments or edge-locations. " +
          "Is this a Cloud WAN core network policy document?"
      );
    }
    renderInfoStrip(model.meta);
    renderGraph(model);
    // Remember what we drew so the simulator can evaluate + place its node, and
    // refresh the region suggestions + clear any stale result for the new policy.
    currentModel = model;
    currentPolicy = policyObject;
    populateRegionOptions(model.meta.edgeLocationRegions || []);
    clearSimResult();
    // Refresh the reachability source/destination dropdowns for the new policy
    // and clear any stale path result/highlight.
    populateReachOptions(model.meta.segmentNames || []);
    clearReachResult();
  } catch (err) {
    // parsePolicy is written to be crash-proof, but we guard anyway so any
    // unexpected condition still surfaces as UI text, never a broken page.
    showError("Could not render this policy: " + err.message);
  }
}

// Parse a raw JSON string safely, then visualize.
function visualizeFromText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    showError("That is not valid JSON: " + err.message);
    return;
  }
  visualize(parsed);
}

// NATIVE-APP BUILD ONLY: expose the safe parse+render entry point so the Tauri
// native file-dialog shim (native.js) can feed a file's text through the exact
// same path the browser FileReader uses. In a plain browser this global is
// simply unused. This is the ONLY line that differs from the web build's app.js.
window.__visualizeFromText = visualizeFromText;

// NATIVE-APP LIVE MODE ONLY: live.js (the "Read live state" flow) feeds a
// deployed policy object straight in, and registers the deployed route table so
// the reachability checker can also answer in DATA-PLANE mode. These globals
// are unused by the web build and by the file/paste flows.
//
// __liveRoutes holds the normalized deployed routes (or null when we are in a
// simulated/file policy). When it is non-null, the reachability panel renders a
// second, clearly-labelled DEPLOYED-ROUTES verdict beneath the POLICY-INTENT
// one, so the user always sees which reading is which.
window.__visualize = visualize;
let liveRoutes = null; // Array from normalizeLiveRoutes(), or null
window.__setLiveRoutes = function (routes) {
  liveRoutes = Array.isArray(routes) ? routes : null;
};
window.__clearLiveRoutes = function () {
  liveRoutes = null;
};

// --- wire up controls --------------------------------------------------------

document.getElementById("btn-example").addEventListener("click", () => {
  visualize(EXAMPLE_POLICY);
});

const fileInput = document.getElementById("file-input");
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const reader = new FileReader(); // reads locally; nothing is uploaded
  reader.onload = () => visualizeFromText(String(reader.result));
  reader.onerror = () => showError("Could not read that file.");
  reader.readAsText(file);
  fileInput.value = ""; // allow re-picking the same file
});

const pastePanel = document.getElementById("paste-panel");
const pasteArea = document.getElementById("paste-area");

document.getElementById("btn-paste").addEventListener("click", () => {
  pastePanel.hidden = !pastePanel.hidden;
  if (!pastePanel.hidden) pasteArea.focus();
});
document.getElementById("btn-paste-cancel").addEventListener("click", () => {
  pastePanel.hidden = true;
});
document.getElementById("btn-render").addEventListener("click", () => {
  const text = pasteArea.value.trim();
  if (!text) {
    showError("Paste a policy JSON document first.");
    return;
  }
  visualizeFromText(text);
});

document.getElementById("side-close").addEventListener("click", closeSidePanel);

// --- attachment simulator UI -------------------------------------------------
// All result rendering below uses createElement + textContent ONLY. Attachment
// values, segment names, rule conditions and tag keys/values are untrusted, so
// they must never reach innerHTML. No eval, no network.

const simPanel = document.getElementById("sim-panel");
const simResult = document.getElementById("sim-result");
const simTagRows = document.getElementById("sim-tag-rows");
const regionOptions = document.getElementById("sim-region-options");

// Offer the policy's edge-locations as region suggestions (free text still ok).
function populateRegionOptions(regions) {
  clearChildren(regionOptions);
  for (const r of regions) {
    const opt = document.createElement("option");
    opt.value = r; // datalist option value; plain text, no HTML
    regionOptions.appendChild(opt);
  }
}

// Add one editable tag key/value row.
function addTagRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "sim-tag-row";

  const k = document.createElement("input");
  k.type = "text";
  k.placeholder = "key (e.g. env)";
  k.value = key;
  k.className = "sim-tag-key";

  const v = document.createElement("input");
  v.type = "text";
  v.placeholder = "value (e.g. prod)";
  v.value = value;
  v.className = "sim-tag-value";

  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "\u2715";
  del.setAttribute("aria-label", "Remove tag");
  del.addEventListener("click", () => row.remove());

  row.append(k, v, del);
  simTagRows.appendChild(row);
}

// Collect the current tag rows into a {key: value} object. Blank keys skipped;
// a later duplicate key overwrites an earlier one (last-wins, like a real map).
function collectTags() {
  const tags = {};
  for (const row of simTagRows.querySelectorAll(".sim-tag-row")) {
    const key = row.querySelector(".sim-tag-key").value.trim();
    const value = row.querySelector(".sim-tag-value").value;
    if (key) tags[key] = value;
  }
  return tags;
}

// Read the whole form into a parser-shaped attachment object.
function readAttachmentForm() {
  return {
    attachmentType: document.getElementById("sim-type").value,
    region: document.getElementById("sim-region").value.trim(),
    accountId: document.getElementById("sim-account").value.trim(),
    resourceId: document.getElementById("sim-resource").value.trim(),
    cidr: document.getElementById("sim-cidr").value.trim(),
    tags: collectTags(),
  };
}

// Hide + empty the result card and remove any simulated node from the graph.
function clearSimResult() {
  clearChildren(simResult);
  simResult.hidden = true;
  clearSimulatedAttachment();
}

// Render the simulation result: verdict, reason, acceptance, expandable trace.
function renderSimResult(result, attachment) {
  clearChildren(simResult);

  const verdict = document.createElement("div");
  verdict.className = "sim-verdict " + (result.associatedSegment ? "ok" : "none");
  if (result.associatedSegment) {
    const ruleTxt = result.matchedRule !== null ? ` \u2014 matched Rule #${result.matchedRule}` : "";
    verdict.textContent = `Associated with segment "${result.associatedSegment}"${ruleTxt}`;
  } else {
    verdict.textContent = "No association";
  }
  simResult.appendChild(verdict);

  const reason = document.createElement("div");
  reason.className = "sim-reason";
  reason.textContent = result.reason; // untrusted-derived -> textContent
  simResult.appendChild(reason);

  if (result.associatedSegment) {
    const accept = document.createElement("div");
    accept.className = "sim-accept";
    accept.textContent = result.acceptanceRequired
      ? "Attachment acceptance: REQUIRED before it joins the segment."
      : "Attachment acceptance: not required (auto-associates).";
    simResult.appendChild(accept);
  }

  if (attachment.cidr) {
    const cidr = document.createElement("div");
    cidr.className = "sim-note";
    cidr.textContent =
      `CIDR ${attachment.cidr} is display-only \u2014 Cloud WAN association is by ` +
      `type/region/account/tags/resource-id, not CIDR.`;
    simResult.appendChild(cidr);
  }

  for (const n of result.notes || []) {
    const note = document.createElement("div");
    note.className = "sim-note";
    note.textContent = n;
    simResult.appendChild(note);
  }

  // Expandable per-rule trace (evaluation order, matched flag, why).
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `Evaluation trace (${result.evaluated.length} rule(s), in order)`;
  details.appendChild(summary);
  for (const row of result.evaluated) {
    const line = document.createElement("div");
    line.className = "sim-trace-row" + (row.matched ? " hit" : "");
    const num = row.ruleNumber !== null ? `Rule #${row.ruleNumber}` : "Rule";
    const flag = row.matched ? "MATCH" : "skip ";
    line.textContent = `${flag}  ${num}: ${row.why}`;
    details.appendChild(line);
  }
  simResult.appendChild(details);

  simResult.hidden = false;
}

document.getElementById("btn-simulate").addEventListener("click", () => {
  simPanel.hidden = !simPanel.hidden;
  if (!simPanel.hidden) {
    // Seed one empty tag row the first time the panel opens.
    if (!simTagRows.querySelector(".sim-tag-row")) addTagRow();
    document.getElementById("sim-region").focus();
  }
});
document.getElementById("btn-sim-close").addEventListener("click", () => {
  simPanel.hidden = true;
});
document.getElementById("btn-sim-add-tag").addEventListener("click", () => addTagRow());

document.getElementById("btn-sim-run").addEventListener("click", () => {
  if (!currentPolicy || !currentModel) {
    showError("Load a policy first, then simulate an attachment against it.");
    return;
  }
  const attachment = readAttachmentForm();
  // Pure engine call -- read-only against the loaded policy, no AWS, no network.
  const result = simulateAttachment(currentPolicy, attachment);
  renderSimResult(result, attachment);
  showSimulatedAttachment(currentModel, attachment, result);
});

document.getElementById("btn-sim-clear").addEventListener("click", clearSimResult);

// Remove all children without touching innerHTML.
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// --- reachability / path checker UI ------------------------------------------
// All result rendering uses createElement + textContent ONLY. Segment names and
// hop reasons are derived from an untrusted policy, so they must never reach
// innerHTML. The engine call is pure + read-only: no eval, no AWS, no network.
//
// LIVE OVERLAY: in the native app's "Read live state" mode, live.js fetches the
// deployed route table (read-only get-network-routes) and registers it via
// window.__setLiveRoutes. When present, this panel renders a second,
// clearly-labelled DEPLOYED-ROUTES verdict beneath the POLICY-INTENT one (see
// renderDataPlaneResult below), so the two readings are never merged. In a
// plain browser / offline mode liveRoutes stays null and only POLICY INTENT
// shows.

const reachPanel = document.getElementById("reach-panel");
const reachResult = document.getElementById("reach-result");
const reachSource = document.getElementById("reach-source");
const reachDest = document.getElementById("reach-dest");

// Fill the source (segments) and destination (segments + Internet) dropdowns
// from the loaded policy's segment list. Uses createElement + textContent only.
function populateReachOptions(segmentNames) {
  clearChildren(reachSource);
  clearChildren(reachDest);
  for (const name of segmentNames) {
    const s = document.createElement("option");
    s.value = name;
    s.textContent = name;
    reachSource.appendChild(s);

    const d = document.createElement("option");
    d.value = name;
    d.textContent = name;
    reachDest.appendChild(d);
  }
  // Internet is always a valid destination for an egress check. Its VALUE is the
  // sentinel "internet" that checkReachability understands; the visible label is
  // friendlier. A distinct value can never collide with a segment name because
  // the engine only treats the exact string "internet" as the egress target.
  const inet = document.createElement("option");
  inet.value = "internet";
  inet.textContent = "Internet (egress)";
  reachDest.appendChild(inet);
}

// Hide + empty the result card and remove any path highlight from the graph.
function clearReachResult() {
  clearChildren(reachResult);
  reachResult.hidden = true;
  clearReachabilityPath();
}

// Render one hop as a "-> [chip] reason" row. kind drives the chip colour.
function reachHopRow(hop, isFirst) {
  const li = document.createElement("li");

  const arrow = document.createElement("span");
  arrow.className = "hop-arrow";
  arrow.textContent = isFirst ? "" : "\u2192"; // no arrow before the source hop
  li.appendChild(arrow);

  const chip = document.createElement("span");
  chip.className = "hop-chip " + (hop.kind || "segment");
  // Friendly label for the internet terminal; otherwise the raw hop name.
  chip.textContent = hop.kind === "internet" ? "Internet" : hop.hop;
  li.appendChild(chip);

  const reason = document.createElement("span");
  reason.className = "hop-reason";
  reason.textContent = hop.reason || ""; // untrusted-derived -> textContent
  li.appendChild(reason);

  return li;
}

// Render the reachability verdict + ordered hop list (or blocked reason).
function renderReachResult(result, source, destination) {
  clearChildren(reachResult);

  // Mode label so the policy-intent card is unambiguous once a DEPLOYED-ROUTES
  // card may appear beneath it in live mode. Harmless in simulate mode.
  const modeLabel = document.createElement("div");
  modeLabel.className = "reach-mode-label";
  modeLabel.textContent = "POLICY INTENT (what the policy permits)";
  reachResult.appendChild(modeLabel);

  const verdict = document.createElement("div");
  verdict.className = "reach-verdict " + (result.reachable ? "ok" : "no");
  const destLabel = destination === "internet" ? "Internet" : destination;
  verdict.textContent = result.reachable
    ? `Reachable: "${source}" \u2192 ${destLabel}`
    : `Not reachable: "${source}" \u2192 ${destLabel}`;
  reachResult.appendChild(verdict);

  if (result.reachable && Array.isArray(result.path) && result.path.length) {
    const ol = document.createElement("ol");
    ol.className = "reach-hops";
    result.path.forEach((hop, i) => ol.appendChild(reachHopRow(hop, i === 0)));
    reachResult.appendChild(ol);
  } else if (!result.reachable) {
    const blocked = document.createElement("div");
    blocked.className = "reach-blocked";
    blocked.textContent = result.blockedReason || "No policy path found.";
    reachResult.appendChild(blocked);
  }

  for (const n of result.notes || []) {
    const note = document.createElement("div");
    note.className = "reach-note";
    note.textContent = n;
    reachResult.appendChild(note);
  }

  reachResult.hidden = false;
}

// LIVE MODE: append a DEPLOYED-ROUTES (data-plane) verdict beneath the
// policy-intent one. Uses createElement + textContent ONLY -- CIDRs, states and
// segment names come from an untrusted AWS response and must never reach
// innerHTML. This block makes the POLICY-INTENT vs DEPLOYED-ROUTES distinction
// explicit: two separately-labelled cards, never merged.
function renderDataPlaneResult(dp, source, destination) {
  const wrap = document.createElement("div");
  wrap.className = "reach-dataplane";

  const label = document.createElement("div");
  label.className = "reach-mode-label";
  label.textContent = "DEPLOYED ROUTES (live data-plane)";
  wrap.appendChild(label);

  const verdict = document.createElement("div");
  verdict.className = "reach-verdict " + (dp.reachable ? "ok" : "no");
  const destLabel = destination === "internet" ? "Internet" : destination;
  verdict.textContent = dp.reachable
    ? `Deployed routes carry: "${source}" \u2192 ${destLabel}`
    : `Deployed routes do NOT carry: "${source}" \u2192 ${destLabel}`;
  wrap.appendChild(verdict);

  if (dp.reachable && Array.isArray(dp.routes) && dp.routes.length) {
    const ul = document.createElement("ul");
    ul.className = "reach-routes";
    for (const r of dp.routes) {
      const li = document.createElement("li");
      li.textContent = `${r.cidr || "(no cidr)"}  [${r.type || "?"}, ${r.state || "?"}]`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }

  if (!dp.reachable && dp.blockedReason) {
    const blocked = document.createElement("div");
    blocked.className = "reach-blocked";
    blocked.textContent = dp.blockedReason;
    wrap.appendChild(blocked);
  }

  // Always surface blackholed routes if any were found -- the key insight.
  if (Array.isArray(dp.blackholed) && dp.blackholed.length) {
    const bh = document.createElement("div");
    bh.className = "reach-note";
    bh.textContent =
      "Blackholed/inactive route(s) to this destination: " +
      dp.blackholed.map((r) => `${r.cidr || "?"} (${r.state || "?"})`).join(", ");
    wrap.appendChild(bh);
  }

  for (const n of dp.notes || []) {
    const note = document.createElement("div");
    note.className = "reach-note";
    note.textContent = n;
    wrap.appendChild(note);
  }

  reachResult.appendChild(wrap);
}

document.getElementById("btn-reach").addEventListener("click", () => {
  reachPanel.hidden = !reachPanel.hidden;
  if (!reachPanel.hidden) reachSource.focus();
});
document.getElementById("btn-reach-close").addEventListener("click", () => {
  reachPanel.hidden = true;
});
document.getElementById("btn-reach-run").addEventListener("click", () => {
  if (!currentPolicy || !currentModel) {
    showError("Load a policy first, then check reachability between its segments.");
    return;
  }
  const source = reachSource.value;
  const destination = reachDest.value;
  if (!source || !destination) {
    showError("Pick a source segment and a destination.");
    return;
  }
  // Pure engine call -- read-only against the loaded policy, no AWS, no network.
  const result = checkReachability(currentPolicy, source, destination);
  renderReachResult(result, source, destination);
  highlightReachabilityPath(currentModel, result);

  // LIVE MODE: if a deployed route table was fetched, also evaluate the
  // DATA-PLANE reading and append it beneath the policy-intent verdict, clearly
  // labelled. Read-only + pure; no AWS call happens here (routes were fetched
  // once at Fetch time). This is what surfaces "policy permits it but the
  // deployed table blackholes it".
  if (liveRoutes) {
    const dp = checkDataPlaneReachability(liveRoutes, source, destination);
    renderDataPlaneResult(dp, source, destination);
  }
});
document.getElementById("btn-reach-clear").addEventListener("click", clearReachResult);

// --- landing screen + mode entry --------------------------------------------
// The app opens on the landing screen (body[data-mode="landing"], set in the
// HTML). The two cards call setMode(); "Change mode" returns here.
//
// GRACEFUL DEGRADATION: "Live view" needs the Tauri API (native app). We detect
// it the same way live.js and native.js do -- window.__TAURI__ presence -- and
// set body[data-tauri] so CSS greys out and disables the live card in a plain
// browser. We also block the click path defensively so live mode can never be
// entered without Tauri, even if the CSS is bypassed.
const hasTauri = !!(window.__TAURI__ && window.__TAURI__.core);
if (hasTauri) body.setAttribute("data-tauri", "yes");

const chooseLive = document.getElementById("choose-live");
if (!hasTauri) {
  chooseLive.disabled = true;
  chooseLive.title = "Live view is available only in the native desktop app.";
}

document.getElementById("choose-offline").addEventListener("click", () => {
  setMode("offline");
});
chooseLive.addEventListener("click", () => {
  if (!hasTauri) return; // defence in depth: never enter live without Tauri
  setMode("live");
});

document.getElementById("btn-change-mode").addEventListener("click", () => {
  // Return to the landing screen; resetVisualization() (inside setMode) clears
  // the graph + panels + any live-routes overlay so nothing leaks between modes.
  setMode("landing");
});

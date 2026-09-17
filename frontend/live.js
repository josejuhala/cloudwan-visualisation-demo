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
 * live.js -- NATIVE-APP ONLY glue for "Read live state" mode.
 *
 * This is the ONE file that talks to AWS, and it does so only through the
 * READ-ONLY Tauri commands in src-tauri/src/aws.rs. It cannot run any AWS verb
 * itself: it calls named commands (list_profiles / list_core_networks /
 * get_live_policy / get_live_routes), and the AWS subcommand for each is chosen
 * in Rust from a fixed allowlist -- never from anything typed here. There is no
 * shell, no fetch, no network from the webview; the aws CLI is spawned inside
 * Rust. See aws.rs for the full read-only-by-construction argument.
 *
 * Why a separate file (not an edit to app.js): app.js stays byte-for-byte the
 * web build plus a few clearly-labelled `window.__*` hooks, so a customer can
 * diff web-vs-native and see the parsing/rendering logic is untouched -- the
 * live behaviour is quarantined here.
 *
 * Graceful degradation: if the Tauri API is absent (plain browser), this file
 * does nothing and the app is the ordinary offline visualizer.
 *
 * DOM: every value that comes back from AWS (profile names, ids, segment
 * names, CIDRs, route states) is rendered with createElement + textContent
 * ONLY -- never innerHTML, no eval.
 */

import { normalizeLiveRoutes } from "./parser.js";

// Tauri v2 exposes its API on window.__TAURI__ when withGlobalTauri is enabled.
// Its absence is the signal we are in a plain browser -> do nothing at all.
const tauri = window.__TAURI__;
if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
  const invoke = tauri.core.invoke;

  // The core networks the user has listed, keyed by CoreNetworkId. Each entry
  // remembers the GlobalNetworkId, which get_live_routes requires (a segment
  // route table is looked up under its global network). list-core-networks
  // returns only summary fields (id + global-network-id + state), NOT the
  // segment/edge lists -- so the segment + edge choices for the routes lookup
  // come from the fetched POLICY document instead (see populateRouteControls).
  let coreNetworks = new Map();
  // The core network + policy the user is currently viewing live, so the routes
  // fetch knows which ids/edges/segments are valid.
  let activeCore = null;

  const banner = document.getElementById("error-banner");
  function showError(msg) {
    if (!banner) return;
    banner.textContent = msg; // textContent -> safe even if msg echoes AWS text
    banner.hidden = false;
  }
  function clearError() {
    if (!banner) return;
    banner.hidden = true;
    banner.textContent = "";
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // --- build the UI (read-only badge + live panel) ---------------------------
  // We inject rather than ship this markup in index.html so index.html stays the
  // same static page the web build serves; the live surface only appears under
  // Tauri. The Offline<->Live *choice* is the landing screen (app.js setMode);
  // this file only supplies the LIVE-mode controls and reacts when the shared
  // setMode() enters/leaves live via the window.__onEnterLive/__onLeaveLive
  // hooks below. The AWS controls live in #live-controls (the header's
  // live-only group, hidden by CSS unless body[data-mode="live"]) plus the
  // #live-panel form, so an OFFLINE user never sees any AWS control and a LIVE
  // user never sees a file/paste/example control.

  const liveControls = document.getElementById("live-controls");

  // READ-ONLY badge: a permanent, unmissable reminder that this mode only ever
  // reads. It sits in the live-only header group, so it shows in live mode only.
  const badge = document.createElement("span");
  badge.id = "readonly-badge";
  badge.textContent = "READ-ONLY";
  badge.title =
    "Live mode runs only read-only aws networkmanager get/list/describe calls. " +
    "It never creates, changes, or deletes anything in your account.";
  liveControls.appendChild(badge);

  // The live panel. Hidden until "Read live state" is chosen. Two stages:
  //   1. connect: pick a profile + region, list core networks, pick one, fetch
  //      its LIVE policy (renders through the same parser as a file/paste).
  //   2. routes overlay: pick a segment + edge + scope, fetch the deployed
  //      route table, register it so the reachability panel shows a DEPLOYED
  //      verdict beside the policy-intent one.
  const panel = document.createElement("section");
  panel.id = "live-panel";
  panel.hidden = true;

  panel.appendChild(makeNote(
    "Live mode runs READ-ONLY aws networkmanager get/list/describe calls via a " +
    "named CLI profile you pick. Nothing is created or changed. Credentials come " +
    "from your AWS CLI config (e.g. `aws sso login`); this app stores none."
  ));

  // Row 1: profile + region + list button.
  const connectGrid = document.createElement("div");
  connectGrid.className = "live-grid";

  const profileSel = makeSelect("live-profile", "AWS profile");
  const regionInput = makeInput("live-region", "Region", "eu-west-1");
  const listBtn = document.createElement("button");
  listBtn.type = "button";
  listBtn.textContent = "List core networks";

  connectGrid.append(
    labelled("AWS profile", profileSel),
    labelled("Region", regionInput),
    wrapButton(listBtn)
  );
  panel.appendChild(connectGrid);

  // Row 2: core network picker + fetch policy.
  const coreGrid = document.createElement("div");
  coreGrid.className = "live-grid";
  coreGrid.hidden = true;

  const coreSel = makeSelect("live-core", "Core network");
  const fetchPolicyBtn = document.createElement("button");
  fetchPolicyBtn.type = "button";
  fetchPolicyBtn.textContent = "Fetch live policy";

  coreGrid.append(labelled("Core network", coreSel), wrapButton(fetchPolicyBtn));
  panel.appendChild(coreGrid);

  // Row 3: routes overlay (segment + edge + scope + fetch). Enabled only after a
  // policy has been fetched, since segment/edge choices come from that policy.
  const routesGrid = document.createElement("div");
  routesGrid.className = "live-grid";
  routesGrid.hidden = true;

  const segSel = makeSelect("live-segment", "Segment");
  const edgeSel = makeSelect("live-edge", "Edge location");
  const scopeSel = makeSelect("live-scope", "Route type");
  addOption(scopeSel, "propagated", "propagated");
  addOption(scopeSel, "static", "static");
  const fetchRoutesBtn = document.createElement("button");
  fetchRoutesBtn.type = "button";
  fetchRoutesBtn.textContent = "Fetch deployed routes";
  const clearRoutesBtn = document.createElement("button");
  clearRoutesBtn.type = "button";
  clearRoutesBtn.textContent = "Clear routes overlay";

  routesGrid.append(
    labelled("Segment", segSel),
    labelled("Edge location", edgeSel),
    labelled("Route type", scopeSel),
    wrapButton(fetchRoutesBtn),
    wrapButton(clearRoutesBtn)
  );
  panel.appendChild(makeNote(
    "Optional: overlay the DEPLOYED route table for one segment edge. The " +
    "reachability checker then shows a second, clearly-labelled DEPLOYED-ROUTES " +
    "verdict beneath POLICY INTENT -- so you can see where the policy permits a " +
    "path but the live table blackholes or omits it."
  ));
  panel.appendChild(routesGrid);

  // A small live-status line (e.g. "Loaded LIVE policy for core-network-...").
  const status = document.createElement("div");
  status.id = "live-status";
  status.hidden = true;
  panel.appendChild(status);

  // Insert the live panel right after the topbar so it sits above the graph.
  // Its visibility is driven entirely by body[data-mode="live"] in CSS -- it is
  // never shown in offline or landing mode. We leave panel.hidden = false so the
  // ONE thing controlling whether AWS controls are visible is the mode
  // attribute, keeping the show/hide rule in one auditable place.
  document.getElementById("topbar").insertAdjacentElement("afterend", panel);
  panel.hidden = false;

  // --- mode entry / exit (driven by app.js's shared setMode) -----------------
  // app.js owns the landing screen and the single setMode() state machine; it
  // calls these hooks when the user enters or leaves LIVE view. We do NOT toggle
  // any mode attribute or panel visibility ourselves -- CSS + data-mode do that.
  // On entry we lazily populate the profile dropdown; on exit we drop any
  // deployed-routes overlay so a later offline reachability check never mixes in
  // stale live data.

  window.__onEnterLive = async function () {
    if (profileSel.options.length === 0) await loadProfiles();
  };

  window.__onLeaveLive = function () {
    if (typeof window.__clearLiveRoutes === "function") window.__clearLiveRoutes();
  };

  // --- data flow -------------------------------------------------------------

  async function loadProfiles() {
    clearError();
    try {
      const names = await invoke("list_profiles");
      clearChildren(profileSel);
      if (!Array.isArray(names) || names.length === 0) {
        addOption(profileSel, "", "(no profiles found in ~/.aws/config)");
        return;
      }
      for (const n of names) addOption(profileSel, n, n);
    } catch (err) {
      showError("Could not read AWS profiles: " + errText(err));
    }
  }

  listBtn.addEventListener("click", async () => {
    clearError();
    const profile = profileSel.value;
    const region = regionInput.value.trim();
    if (!profile) return showError("Pick an AWS profile first.");
    if (!region) return showError("Enter a Region (e.g. eu-west-1).");

    setStatus("Listing core networks\u2026");
    try {
      const raw = await invoke("list_core_networks", { profile, region });
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed.CoreNetworks) ? parsed.CoreNetworks : [];
      coreNetworks = new Map();
      clearChildren(coreSel);
      if (list.length === 0) {
        coreGrid.hidden = true;
        return setStatus("No core networks found in this account/region.");
      }
      for (const cn of list) {
        const id = typeof cn.CoreNetworkId === "string" ? cn.CoreNetworkId : "";
        if (!id) continue;
        coreNetworks.set(id, {
          globalNetworkId:
            typeof cn.GlobalNetworkId === "string" ? cn.GlobalNetworkId : "",
        });
        addOption(coreSel, id, id);
      }
      coreGrid.hidden = false;
      setStatus(`Found ${coreNetworks.size} core network(s). Pick one and fetch its live policy.`);
    } catch (err) {
      coreGrid.hidden = true;
      showError("Could not list core networks: " + errText(err));
    }
  });

  fetchPolicyBtn.addEventListener("click", async () => {
    clearError();
    const profile = profileSel.value;
    const region = regionInput.value.trim();
    const coreId = coreSel.value;
    if (!coreId) return showError("Pick a core network first.");

    setStatus("Fetching live policy\u2026");
    try {
      const raw = await invoke("get_live_policy", {
        profile,
        region,
        coreNetworkId: coreId,
      });
      const parsed = JSON.parse(raw);
      // get-core-network-policy returns the policy document as a JSON *string*.
      const docStr = parsed && parsed.CoreNetworkPolicy
        ? parsed.CoreNetworkPolicy.PolicyDocument
        : undefined;
      if (typeof docStr !== "string") {
        return showError("The live policy response had no PolicyDocument string.");
      }
      const policyObject = JSON.parse(docStr);

      // Render it through the SAME parser + renderer as a file/paste policy.
      if (typeof window.__visualize === "function") window.__visualize(policyObject);

      // Remember which core network is live so the routes fetch is scoped to it,
      // and drop any previous overlay so verdicts never mix networks.
      activeCore = { id: coreId, meta: coreNetworks.get(coreId) || {} };
      if (typeof window.__clearLiveRoutes === "function") window.__clearLiveRoutes();

      populateRouteControls(policyObject);
      routesGrid.hidden = false;
      setStatus(`Loaded LIVE policy for ${coreId}.`);
    } catch (err) {
      routesGrid.hidden = true;
      showError("Could not fetch the live policy: " + errText(err));
    }
  });

  fetchRoutesBtn.addEventListener("click", async () => {
    clearError();
    if (!activeCore) return showError("Fetch a live policy first.");
    const profile = profileSel.value;
    const region = regionInput.value.trim();
    const segment = segSel.value;
    const edge = edgeSel.value;
    const scope = scopeSel.value;
    const globalId = activeCore.meta.globalNetworkId;

    if (!globalId) {
      return showError(
        "This core network did not report a GlobalNetworkId, which " +
        "get-network-routes requires. Try re-listing core networks."
      );
    }
    if (!segment) return showError("Pick a segment.");
    if (!edge) return showError("Pick an edge location (Region).");

    setStatus("Fetching deployed routes\u2026");
    try {
      const raw = await invoke("get_live_routes", {
        profile,
        region,
        globalNetworkId: globalId,
        coreNetworkId: activeCore.id,
        segmentName: segment,
        edgeLocation: edge,
        scope,
      });
      const parsed = JSON.parse(raw);
      const routes = normalizeLiveRoutes(parsed);
      if (typeof window.__setLiveRoutes === "function") window.__setLiveRoutes(routes);
      setStatus(
        `Loaded ${routes.length} deployed ${scope} route(s) for segment "${segment}" ` +
        `@ ${edge}. Open "Check reachability" to see the DEPLOYED-ROUTES overlay.`
      );
    } catch (err) {
      showError("Could not fetch deployed routes: " + errText(err));
    }
  });

  clearRoutesBtn.addEventListener("click", () => {
    if (typeof window.__clearLiveRoutes === "function") window.__clearLiveRoutes();
    setStatus("Cleared the deployed-routes overlay.");
  });

  // --- helpers ---------------------------------------------------------------

  // Fill segment + edge dropdowns from the live policy. Cloud WAN segment route
  // tables are per-segment-per-edge, so get-network-routes needs BOTH -- and the
  // fetched policy document is the source of truth for which segments and edge
  // locations this core network actually has.
  function populateRouteControls(policyObject) {
    const segNames = extractPolicySegments(policyObject);
    const edges = extractPolicyEdges(policyObject);

    clearChildren(segSel);
    for (const s of segNames) addOption(segSel, s, s);
    clearChildren(edgeSel);
    for (const e of edges) addOption(edgeSel, e, e);
  }

  function extractPolicySegments(policyObject) {
    const out = [];
    const segs = policyObject && Array.isArray(policyObject.segments) ? policyObject.segments : [];
    for (const s of segs) {
      if (s && typeof s.name === "string") out.push(s.name);
    }
    return out;
  }

  function extractPolicyEdges(policyObject) {
    const cfg = policyObject && policyObject["core-network-configuration"];
    const locs = cfg && Array.isArray(cfg["edge-locations"]) ? cfg["edge-locations"] : [];
    const out = [];
    for (const l of locs) {
      if (l && typeof l.location === "string") out.push(l.location);
    }
    return out;
  }

  function setStatus(text) {
    status.textContent = text; // textContent -> safe
    status.hidden = false;
  }

  // Tauri command errors arrive as strings (our AwsError serializes to a string).
  function errText(err) {
    if (typeof err === "string") return err;
    if (err && typeof err.message === "string") return err.message;
    return String(err);
  }

  // Small DOM factories -- all createElement/textContent, no innerHTML.
  function makeSelect(id, ariaLabel) {
    const s = document.createElement("select");
    s.id = id;
    s.setAttribute("aria-label", ariaLabel);
    return s;
  }
  function makeInput(id, ariaLabel, placeholder) {
    const i = document.createElement("input");
    i.type = "text";
    i.id = id;
    i.setAttribute("aria-label", ariaLabel);
    if (placeholder) i.placeholder = placeholder;
    return i;
  }
  function addOption(sel, value, text) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }
  function labelled(text, control) {
    const l = document.createElement("label");
    l.textContent = text;
    l.appendChild(control);
    return l;
  }
  function wrapButton(btn) {
    const w = document.createElement("div");
    w.className = "live-btn-wrap";
    w.appendChild(btn);
    return w;
  }
  function makeNote(text) {
    const n = document.createElement("p");
    n.className = "live-note";
    n.textContent = text;
    return n;
  }
}

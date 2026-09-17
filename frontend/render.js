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
 * render.js -- draw the graph model from parser.js with Cytoscape.js and build
 * the segment side panel.
 *
 * SECURITY: every string here originates from an untrusted policy document.
 *  - Cytoscape node/edge LABELS are set via the stylesheet `label: data(label)`,
 *    which Cytoscape renders onto a canvas as plain text (no HTML parsing).
 *  - The side panel is built ONLY with document.createElement + textContent.
 *    There is deliberately NO innerHTML anywhere in this file, so policy values
 *    can never inject markup or script. Do not "simplify" this with innerHTML.
 */

// Cytoscape is loaded globally from the pinned CDN <script> in index.html.

// Layout geometry constants (in graph coordinates). Tuned for legibility; the
// preset layout below uses these to place every node manually.
const COL_W = 220; // horizontal spacing between region columns
const LANE_H = 90; // vertical height of one segment lane
// Gap between stacked lanes. Widened from 24 -> 48 (2x) so the on-click
// fan-out routing bows (see fanOutEdges / FAN_STEP) get clear whitespace
// between adjacent lanes instead of crowding into the neighbouring bar. Lane
// HEIGHT is left at 90 -- growing only the gap gives the arrows room without
// making the bars themselves oversized. Row pitch is LANE_H + LANE_GAP, so
// this raises the adjacent-lane pitch from 114 -> 138.
const LANE_GAP = 48; // gap between stacked lanes
const BAND_TOP = 120; // y where the first segment lane starts

// Inspection NFGs sit on a dedicated vertical RAIL to the LEFT of the segment
// lanes (a negative X gutter reserved just for them), so an inspection path
// reads as segment -> left firewall rail -> destination (a chokepoint/hairpin).
// Egress ("send-to internet") targets sit far to the RIGHT as "the outside".
const LEFT_RAIL_X = -320; // NFG rail X, left of the first region column (x=0)
const NFG_V_GAP = 96; // vertical spacing between stacked NFG nodes on the rail
const EGRESS_GAP_X = 260; // right-of-lanes X gap from the widest lane edge
const EGRESS_V_GAP = 110; // vertical spacing between stacked egress nodes

// Inline SVG icons as data:image/svg+xml URIs. These are embedded verbatim in
// the JS -- NO network fetch, no CDN, no icon font -- so the whole app stays
// fully offline and the CDN <script>/SRI is untouched. `#` in the fill/stroke
// colors is pre-encoded as %23 so the URI is valid without any runtime munging.
// Cytoscape draws these via `background-image` with background-fit:contain.
const ICON_SHIELD =
  'data:image/svg+xml,' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5z" ' +
  'fill="none" stroke="%23ff5370" stroke-width="1.6"/>' +
  '<path d="M4 9h16M4 13h16M9 5v4M15 9v4M9 13v5M15 13v5" ' +
  'stroke="%23ff9fb0" stroke-width="1.1" fill="none"/>' +
  '</svg>';
const ICON_GLOBE =
  'data:image/svg+xml,' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<circle cx="12" cy="12" r="9" fill="none" stroke="%2340c4ff" stroke-width="1.6"/>' +
  '<path d="M3 12h18M12 3v18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18' +
  'M4 8c5 2 11 2 16 0M4 16c5-2 11-2 16 0" ' +
  'fill="none" stroke="%2380d8ff" stroke-width="1.1"/>' +
  '</svg>';

// Simulated-attachment VPC glyph -- a dashed cloud-box, cyan-green so it reads
// as "hypothetical / what-if" and never as a real policy element. Same offline
// data-URI approach as the icons above (no fetch, CDN/SRI untouched).
const ICON_VPC =
  'data:image/svg+xml,' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<rect x="3" y="6" width="18" height="12" rx="2" fill="none" ' +
  'stroke="%233ddc97" stroke-width="1.6" stroke-dasharray="3 2"/>' +
  '<path d="M7 10h10M7 14h6" stroke="%238affd1" stroke-width="1.2" fill="none"/>' +
  '</svg>';

// Cytoscape stylesheet. Colors mirror style.css / the legend.
//
// DARK VIOLET theme: luminous violet lanes on a dark navy canvas. Every node
// carries a `transition-property`/`transition-duration` on opacity so entering
// and leaving focus mode fades smoothly instead of hard-flipping. A `.hover`
// class (added/removed on mouseover/mouseout in renderGraph) lifts lanes and
// region headers so it is obvious they are clickable.
//
// DEFAULT (calm) view: segment lanes and region headers only. Routing edges
// (share / leak / inspection) all start HIDDEN via the `.routing` +
// display:none rule and are only revealed on the focused segment.
const CY_STYLE = [
  // Region column header (one per edge-location, across the top).
  {
    selector: 'node[kind = "edge-location"]',
    style: {
      "background-color": "#1a2440",
      "background-opacity": 0.92,
      "border-width": 1,
      "border-color": "#7c4dff",
      shape: "round-rectangle",
      label: "data(label)",
      color: "#b388ff",
      "text-valign": "center",
      "text-halign": "center",
      "font-size": "11px",
      "font-weight": "bold",
      "text-wrap": "wrap",
      "text-max-width": `${COL_W - 40}px`,
      width: `${COL_W - 30}px`,
      height: "44px",
      // Smooth dim/undim.
      "transition-property": "opacity, border-width, border-color",
      "transition-duration": "180ms",
    },
  },
  // Segment lane: a full-width horizontal bar.
  {
    selector: 'node[kind = "segment"]',
    style: {
      // Dark translucent violet fill with a bright violet border + outer glow.
      "background-color": "#7c4dff",
      "background-opacity": 0.1,
      "border-width": 2,
      "border-color": "#7c4dff",
      shape: "round-rectangle",
      // Soft outer glow via a coloured overlay at rest.
      "overlay-color": "#7c4dff",
      "overlay-opacity": 0.06,
      "overlay-padding": "6px",
      label: "data(label)",
      color: "#e8eaf6",
      "text-valign": "center",
      // Center-anchor the label inside the lane bounding box. text-halign:"left"
      // anchors the label OUTSIDE the node's left edge (it hung in the margin),
      // and a small +margin was not enough to pull it back inside a wide bar.
      "text-halign": "center",
      "font-size": "14px",
      "font-weight": "bold",
      "width": "data(w)",
      "height": `${LANE_H}px`,
      "transition-property": "opacity, border-width, border-color, background-opacity, overlay-opacity",
      "transition-duration": "180ms",
    },
  },
  // Inspection NFG node -- a PROMINENT firewall on the left rail (only appears
  // when a policy has service insertion). Larger box, pink accent, with an
  // inline-SVG shield icon drawn behind the label via background-image.
  {
    selector: 'node[kind = "nfg"]',
    style: {
      "background-color": "#2a1620",
      "background-opacity": 0.95,
      "border-width": 2,
      "border-color": "#ff5370",
      shape: "round-rectangle",
      // Inline data-URI shield icon (offline, no fetch). background-fit:contain
      // keeps it crisp; positioned in the upper portion so the label sits below.
      "background-image": ICON_SHIELD,
      "background-fit": "contain",
      "background-image-opacity": 0.95,
      "background-width": "40px",
      "background-height": "40px",
      "background-position-y": "6px",
      label: "data(label)",
      color: "#ff9fb0",
      "text-valign": "bottom",
      "text-halign": "center",
      "text-margin-y": "4px",
      "font-size": "11px",
      "font-weight": "bold",
      "text-wrap": "wrap",
      "text-max-width": "100px",
      width: "104px",
      height: "72px",
      // Strong glow so the firewall rail reads as important.
      "overlay-color": "#ff5370",
      "overlay-opacity": 0.22,
      "overlay-padding": "5px",
      "transition-property": "opacity",
      "transition-duration": "180ms",
    },
  },
  // Egress ("send-to internet") node -- THE OUTSIDE. A distinct cyan node with
  // an inline-SVG globe icon, deliberately a different accent from the violet
  // lanes and the pink NFG so it clearly reads as "the internet".
  {
    selector: 'node[kind = "egress"]',
    style: {
      "background-color": "#0d2733",
      "background-opacity": 0.95,
      "border-width": 2,
      "border-color": "#40c4ff",
      shape: "round-rectangle",
      "background-image": ICON_GLOBE,
      "background-fit": "contain",
      "background-image-opacity": 0.95,
      "background-width": "40px",
      "background-height": "40px",
      "background-position-y": "6px",
      label: "data(label)",
      color: "#80d8ff",
      "text-valign": "bottom",
      "text-halign": "center",
      "text-margin-y": "4px",
      "font-size": "11px",
      "font-weight": "bold",
      "text-wrap": "wrap",
      "text-max-width": "100px",
      width: "96px",
      height: "72px",
      "overlay-color": "#40c4ff",
      "overlay-opacity": 0.2,
      "overlay-padding": "5px",
      "transition-property": "opacity",
      "transition-duration": "180ms",
    },
  },
  // --- hover affordance -----------------------------------------------------
  // A `.hover` class is toggled in renderGraph on mouseover/mouseout of
  // clickable lanes and region headers -- brighten the border + intensify the
  // glow so it "lifts". Cursor:pointer is set on the container in renderGraph.
  {
    selector: 'node[kind = "segment"].hover',
    style: {
      "border-color": "#b388ff",
      "border-width": 3,
      "background-opacity": 0.18,
      "overlay-opacity": 0.14,
    },
  },
  {
    selector: 'node[kind = "edge-location"].hover',
    style: { "border-color": "#b388ff", "border-width": 2 },
  },

  // --- routing edges: hidden at rest, shown only in focus mode --------------
  { selector: "edge.routing", style: { display: "none" } },

  // Bidirectional share -- solid bright teal glow, arrowheads at both ends.
  {
    selector: 'edge[kind = "share"].shown',
    style: {
      display: "element",
      "line-color": "#26e0c8",
      "source-arrow-color": "#26e0c8",
      "target-arrow-color": "#26e0c8",
      "source-arrow-shape": "triangle",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      width: 4,
      "overlay-color": "#26e0c8",
      "overlay-opacity": 0.18,
      "overlay-padding": "2px",
    },
  },
  // One-way leak -- amber dashed, single arrow in the leak direction. The dash
  // pattern + line-dash-offset are animated in renderGraph so the leak "flows".
  {
    selector: 'edge[kind = "leak"].shown',
    style: {
      display: "element",
      "line-color": "#ffb300",
      "line-style": "dashed",
      "line-dash-pattern": [8, 4],
      "target-arrow-color": "#ffb300",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      width: 3,
      "overlay-color": "#ffb300",
      "overlay-opacity": 0.14,
      "overlay-padding": "2px",
      label: "one-way leak",
      "font-size": "9px",
      color: "#ffd27a",
      "text-background-color": "#0d1526",
      "text-background-opacity": 0.9,
      "text-background-padding": "2px",
    },
  },
  // Inspection: segment -> NFG -> segment (or -> egress). Red/pink, animated.
  {
    selector: 'edge[kind = "inspection"].shown',
    style: {
      display: "element",
      "line-color": "#ff5370",
      "line-style": "dashed",
      "line-dash-pattern": [8, 4],
      "target-arrow-color": "#ff5370",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      width: 3,
      "overlay-color": "#ff5370",
      "overlay-opacity": 0.16,
      "overlay-padding": "2px",
      label: "data(label)",
      "font-size": "9px",
      color: "#ff9fb0",
      "text-background-color": "#0d1526",
      "text-background-opacity": 0.9,
      "text-background-padding": "2px",
    },
  },
  { selector: "node.nfg-node.shown", style: { display: "element" } },
  { selector: "node.egress-node.shown", style: { display: "element" } },

  // --- attachment simulator ------------------------------------------------
  // A hypothetical "what-if" attachment the user typed into the Simulate panel.
  // Drawn as a distinct DASHED cyan-green VPC glyph so it never reads as a real
  // policy element. It is added/removed on the live graph by
  // showSimulatedAttachment / clearSimulatedAttachment (additive -- it does not
  // participate in focus/dim state, so it stays visible in every mode).
  {
    selector: 'node[kind = "sim-attachment"]',
    style: {
      "background-color": "#0d2b26",
      "background-opacity": 0.95,
      "border-width": 2,
      "border-color": "#3ddc97",
      "border-style": "dashed",
      shape: "round-rectangle",
      "background-image": ICON_VPC,
      "background-fit": "contain",
      "background-image-opacity": 0.95,
      "background-width": "34px",
      "background-height": "34px",
      "background-position-y": "6px",
      label: "data(label)",
      color: "#8affd1",
      "text-valign": "bottom",
      "text-halign": "center",
      "text-margin-y": "3px",
      "font-size": "10px",
      "font-weight": "bold",
      "text-wrap": "wrap",
      "text-max-width": "120px",
      width: "120px",
      height: "66px",
      "overlay-color": "#3ddc97",
      "overlay-opacity": 0.18,
      "overlay-padding": "5px",
      "z-index": 50,
    },
  },
  // Unassociated variant -- amber dashed, drawn off to the side, no lane link.
  {
    selector: 'node[kind = "sim-attachment"].unassociated',
    style: { "border-color": "#ffb300", color: "#ffd27a", "overlay-color": "#ffb300" },
  },
  // Dashed link from the simulated attachment down into its winning lane.
  {
    selector: 'edge[kind = "sim-link"]',
    style: {
      "line-color": "#3ddc97",
      "line-style": "dashed",
      "line-dash-pattern": [6, 4],
      "target-arrow-color": "#3ddc97",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      width: 3,
      "z-index": 49,
    },
  },

  // --- reachability path highlight -----------------------------------------
  // A checked reachability path is drawn as its own bright violet chain of
  // `path-edge` connectors (added/removed by highlight/clearReachabilityPath),
  // with a private `path-dim` / `path-hop` dim scheme that does NOT touch the
  // click-focus `.dimmed`/`.focused` classes. Reuses the dashed dash-flow feel.
  {
    selector: 'edge[kind = "path"]',
    style: {
      display: "element",
      "line-color": "#b388ff",
      "line-style": "dashed",
      "line-dash-pattern": [10, 5],
      "target-arrow-color": "#b388ff",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      width: 4,
      "overlay-color": "#b388ff",
      "overlay-opacity": 0.2,
      "overlay-padding": "3px",
      "z-index": 60,
    },
  },
  // Path dimming (private to the reachability highlight).
  { selector: ".path-dim", style: { opacity: 0.1 } },
  // Path hops pop above the dim; a violet ring marks each node on the path.
  {
    selector: 'node.path-hop',
    style: {
      opacity: 1,
      "border-width": 4,
      "border-color": "#b388ff",
      "overlay-color": "#b388ff",
      "overlay-opacity": 0.2,
      "z-index": 61,
    },
  },

  // --- focus dimming --------------------------------------------------------
  // Lower opacity so the focused element clearly pops against the dark canvas.
  { selector: ".dimmed", style: { opacity: 0.12 } },
  { selector: 'node[kind = "segment"].focused', style: { "border-width": 4, "border-color": "#b388ff", "background-opacity": 0.22, "overlay-opacity": 0.18 } },
  // Region-focus: emphasise the clicked region column header the same way a
  // focused segment lane is emphasised (thicker border, bright accent).
  { selector: 'node[kind = "edge-location"].focused', style: { "border-width": 3, "border-color": "#b388ff" } },
];

// Dash-flow animation constants. Animating line-dash-offset on the shown
// routing edges makes the dashes visibly travel in the arrow direction. Kept
// subtle: a slow, single looping animation (not per-edge chained work).
const DASH_STEP = 12; // offset decrement per tick (matches [8,4] pattern span)
const DASH_INTERVAL_MS = 90; // tick cadence -- slow, non-distracting flow

let cy = null; // single Cytoscape instance, recreated on each render
let dashTimer = null; // setInterval handle for the routing-edge dash flow
let focusedSegment = null; // name of the currently focused segment, or null
let focusedRegion = null; // region of the currently focused edge-location, or null

/**
 * Render a parsed graph model into #cy using a manually-computed SWIMLANE
 * layout (Cytoscape 'preset' layout -- we supply every x/y ourselves).
 *
 *   - Regions are vertical columns (left to right, one per edge-location).
 *   - Segments are full-width horizontal lanes, stacked in a Cloud WAN band.
 *   - Routing (share / leak / inspection) is HIDDEN at rest and revealed only
 *     when a segment lane is clicked (see focusSegment). Attachment-policy rules
 *     and static routes are NOT drawn on the canvas -- they surface in the
 *     segment side panel instead, from the parser model.
 *
 * @param {{nodes: Array, edges: Array, meta: Object}} model
 */
export function renderGraph(model) {
  const container = document.getElementById("cy");
  if (cy) {
    cy.destroy();
    cy = null;
  }
  // Stop any dash-flow animation left running from a previous render.
  if (dashTimer) {
    clearInterval(dashTimer);
    dashTimer = null;
  }
  focusedSegment = null;
  focusedRegion = null;

  const { elements, positions } = buildSwimlaneElements(model);

  cy = cytoscape({
    container,
    elements,
    style: CY_STYLE,
    layout: { name: "preset", positions, fit: true, padding: 40 },
    wheelSensitivity: 0.2,
    // Lanes are backdrops; let clicks through reliably but keep pan/zoom.
    boxSelectionEnabled: false,
    // Static layout: the swimlane positions are meaningful, so the user must
    // not be able to drag boxes around. autoungrabify makes every node
    // non-grabbable. Zoom (scroll) and pan (drag empty background) are left ON
    // deliberately -- a multi-region policy needs them -- so we do NOT set
    // userZoomingEnabled / userPanningEnabled to false.
    autoungrabify: true,
  });

  // Click a segment lane -> focus it (reveal its routing, dim the rest).
  cy.on("tap", 'node[kind = "segment"]', (evt) => {
    focusSegment(model, evt.target.data("name"));
  });
  // Click a region column header -> presence filter (highlight only the
  // segments present in that region, dim the rest). Parallel to focusSegment.
  cy.on("tap", 'node[kind = "edge-location"]', (evt) => {
    focusRegion(model, evt.target.data("region"));
  });
  // Click empty background -> reset to the calm overview.
  cy.on("tap", (evt) => {
    if (evt.target === cy) resetFocus();
  });

  // --- Option C: hover affordance -------------------------------------------
  // Toggle a `.hover` class (styled in CY_STYLE) on the clickable elements so
  // lanes and region headers visibly lift/brighten, and swap the container
  // cursor to a pointer. Pure presentation -- no focus/data state is touched.
  const clickable = 'node[kind = "segment"], node[kind = "edge-location"]';
  cy.on("mouseover", clickable, (evt) => {
    evt.target.addClass("hover");
    container.style.cursor = "pointer";
  });
  cy.on("mouseout", clickable, (evt) => {
    evt.target.removeClass("hover");
    container.style.cursor = "default";
  });

  // --- Option C: animated flow on revealed routing edges --------------------
  // A single slow loop decrements line-dash-offset on every currently-shown
  // dashed routing edge, so the dashes travel in the arrow direction. Only the
  // `.shown` edges are addressed, so at rest (nothing focused) this is a no-op.
  let dashOffset = 0;
  dashTimer = setInterval(() => {
    if (!cy) return;
    dashOffset = (dashOffset - DASH_STEP) % 1000;
    cy.edges("edge.routing.shown").style("line-dash-offset", dashOffset);
  }, DASH_INTERVAL_MS);
}

// Build the Cytoscape element list AND a preset position map from the model.
// Positions are plain numbers computed here, so there is never a NaN unless a
// region/segment index is missing -- which we guard against.
function buildSwimlaneElements(model) {
  const regions = model.meta.edgeLocationRegions; // ordered
  const segments = model.nodes.filter((n) => n.data.kind === "segment");
  const positions = {};
  const nodes = [];
  const edges = [];

  // Column X for a region by its index.
  const colX = (idx) => idx * COL_W;
  const totalWidth = Math.max(regions.length, 1) * COL_W;

  // --- region column headers (across the top) --------------------------------
  regions.forEach((region, i) => {
    const src = model.nodes.find(
      (n) => n.data.kind === "edge-location" && n.data.region === region
    );
    const id = src ? src.data.id : "edge:" + region;
    nodes.push({ data: { id, kind: "edge-location", region, label: src ? src.data.label : region } });
    positions[id] = { x: colX(i), y: 40 };
  });

  // --- segment lanes (full-width bars, stacked) ------------------------------
  segments.forEach((seg, i) => {
    const name = seg.data.name;
    const laneW = totalWidth + COL_W * 0.4; // a touch wider than the columns
    const y = BAND_TOP + i * (LANE_H + LANE_GAP);
    nodes.push({
      data: {
        id: seg.data.id,
        kind: "segment",
        name,
        label: laneLabel(seg.data),
        w: `${laneW}px`,
      },
    });
    // Center the lane across the columns.
    positions[seg.data.id] = { x: (regions.length - 1) * COL_W * 0.5, y };
  });

  // NOTE: attachment-policy rule markers and their drop-lines are intentionally
  // NOT drawn on the canvas -- they cluttered the always-on view. The parser
  // still computes model.meta.rulesBySegment, and showSegmentPanel lists those
  // rules when a segment is clicked, so no information is lost. `laneY` is kept
  // below because the NFG / inspection placement still uses it.
  const laneY = (name) => {
    const idx = segments.findIndex((s) => s.data.name === name);
    return BAND_TOP + idx * (LANE_H + LANE_GAP);
  };

  // --- NFG nodes: a prominent vertical firewall RAIL to the LEFT of the lanes.
  // Placed at a fixed negative X (left gutter) and spread vertically, centered
  // on the segment band, so an inspection path reads segment -> left rail ->
  // destination. Hidden until a segment with inspection is focused.
  const nfgCount = model.meta.nfgNames.length;
  const bandMidY = BAND_TOP + ((Math.max(segments.length, 1) - 1) * (LANE_H + LANE_GAP)) / 2;
  const nfgTop = bandMidY - ((Math.max(nfgCount, 1) - 1) * NFG_V_GAP) / 2;
  model.meta.nfgNames.forEach((nfgName, i) => {
    const id = "nfg:" + nfgName;
    nodes.push({
      data: { id, kind: "nfg", name: nfgName, label: nfgName },
      classes: "nfg-node",
    });
    positions[id] = { x: LEFT_RAIL_X, y: nfgTop + i * NFG_V_GAP };
  });

  // --- routing edges (all hidden at rest via the `.routing` class) -----------
  // Share / leak straight from the parser model.
  for (const edge of model.edges) {
    if (edge.data.kind === "share" || edge.data.kind === "leak") {
      edges.push({ data: { ...edge.data }, classes: "routing" });
    }
  }
  // NOTE: standalone create-route glyph nodes and their links are intentionally
  // NOT drawn -- they cluttered the canvas as always-present diamonds. The
  // parser still emits the "route" nodes in model.nodes, and showSegmentPanel
  // reads them straight from the model to list a segment's static routes
  // (including blackhole), so the routing detail survives on segment-click.
  // Inspection: segment -> NFG -> segment (or NFG -> egress marker).
  let egressSeq = 0;
  model.meta.inspections.forEach((ins, i) => {
    const nfgNodeId = "nfg:" + ins.nfg;
    const fromId = "seg:" + ins.fromSegment;
    const modeTag = ins.mode ? ` (${ins.mode})` : "";
    edges.push({
      data: {
        id: `insp-in:${i}`,
        source: fromId,
        target: nfgNodeId,
        kind: "inspection",
        label: "via NFG" + modeTag,
        segment: ins.fromSegment,
        otherSegment: ins.toSegment,
      },
      classes: "routing",
    });
    if (ins.toSegment) {
      edges.push({
        data: {
          id: `insp-out:${i}`,
          source: nfgNodeId,
          target: "seg:" + ins.toSegment,
          kind: "inspection",
          label: "",
          segment: ins.fromSegment,
          otherSegment: ins.toSegment,
        },
        classes: "routing",
      });
    } else {
      // send-to (north-south egress): NFG -> a distinct INTERNET node placed
      // far to the RIGHT of the lanes ("the outside"). Each egress node is
      // offset vertically by its sequence index so multiple send-to egresses in
      // one policy stack cleanly instead of overlapping at one point. The X sits
      // a fixed gap to the right of the widest lane's right edge.
      const thisEgress = egressSeq++;
      const egressId = `egress:${thisEgress}`;
      const laneW = totalWidth + COL_W * 0.4;
      const laneCenterX = (regions.length - 1) * COL_W * 0.5;
      const egressX = laneCenterX + laneW / 2 + EGRESS_GAP_X;
      nodes.push({
        data: { id: egressId, kind: "egress", segment: ins.fromSegment, label: "internet" },
        classes: "egress-node",
      });
      positions[egressId] = { x: egressX, y: bandMidY + thisEgress * EGRESS_V_GAP };
      edges.push({
        data: {
          id: `insp-egress:${i}`,
          source: nfgNodeId,
          target: egressId,
          kind: "inspection",
          label: "egress",
          segment: ins.fromSegment,
          otherSegment: null,
        },
        classes: "routing",
      });
    }
  });

  return { elements: { nodes, edges }, positions };
}

// Lane label is the segment name only. Region and the isolate/acceptance flags
// live in the click side panel, so we keep them off the on-graph label to avoid
// clutter. `seg.name` is already the parser's defensive value ("(unnamed
// segment)" when a segment declares no name), so no extra guard is needed here.
function laneLabel(seg) {
  return seg.name;
}

// --- focus mode --------------------------------------------------------------

// Reveal one segment's routing; dim everything unrelated; open the side panel.
function focusSegment(model, name) {
  if (!cy) return;
  focusedSegment = name;
  focusedRegion = null; // switching modes: a segment click clears region focus
  const segId = "seg:" + name;

  // Collect the routing edges that belong to this segment and the nodes they
  // touch, so we can un-dim exactly the relevant subgraph.
  const relatedNodeIds = new Set([segId]);
  const shownEdges = cy.collection();

  cy.edges().forEach((edge) => {
    const d = edge.data();
    let belongs = false;
    if (d.kind === "share" || d.kind === "leak") {
      belongs = d.source === segId || d.target === segId;
    } else if (d.kind === "inspection") {
      belongs = d.segment === name;
    }
    if (belongs) {
      shownEdges.merge(edge);
      relatedNodeIds.add(d.source);
      relatedNodeIds.add(d.target);
    }
  });

  // Apply visibility + dimming.
  cy.elements().removeClass("shown focused dimmed");
  // Clear any per-edge fan-out styling left inline from a previous focus, so a
  // segment whose edges are NOT re-styled below reverts to the plain bezier
  // stylesheet default instead of keeping a stale bow.
  cy.edges("edge.routing").removeStyle(
    "curve-style control-point-distances control-point-weights"
  );
  shownEdges.addClass("shown");
  // Fan the parallel routing edges apart. Every segment lane shares the same X
  // center, so multiple share/leak/inspection edges for one focused segment
  // would otherwise trace the same vertical path and stack into one thick line.
  // We bow each shown edge to a different side with `unbundled-bezier` control
  // points, using a stable index within THIS segment's shown edges so the
  // spread is deterministic (not random) and re-focusing looks identical.
  fanOutEdges(shownEdges);
  shownEdges.connectedNodes().addClass("shown"); // reveal nfg / egress nodes
  cy.getElementById(segId).addClass("shown focused");

  cy.nodes().forEach((n) => {
    if (!relatedNodeIds.has(n.id()) && n.data("kind") !== "segment") {
      // Non-related helper nodes dim; unrelated segment lanes also dim.
      n.addClass("dimmed");
    }
    if (n.data("kind") === "segment" && n.id() !== segId) n.addClass("dimmed");
  });

  const seg = model.nodes.find((n) => n.data.kind === "segment" && n.data.name === name);
  showSegmentPanel(seg ? seg.data : { name }, model);
}

// Presence filter for a region click. Highlights ONLY the segment lanes present
// in the clicked region and the region column itself; dims every other segment
// lane and the other region columns. Deliberately draws NO routing edges --
// routing stays a segment-click concern; this is purely a "who is here" view.
function focusRegion(model, region) {
  if (!cy) return;
  focusedRegion = region;
  focusedSegment = null; // switching modes: a region click clears segment focus

  // Set of segment names present in this region, from the parser's additive
  // presence map. A region with no matching segments yields an empty set, so we
  // simply highlight nothing extra (never crash).
  const present = (model.meta.segmentsByRegion &&
    model.meta.segmentsByRegion[region]) || [];
  const presentNames = new Set(present.map((p) => p.name));
  const regionId = "edge:" + region;

  // Start clean (also wipes any prior segment-focus state), then apply dimming.
  cy.elements().removeClass("shown focused dimmed");
  cy.edges("edge.routing").removeStyle(
    "curve-style control-point-distances control-point-weights"
  );

  // Keep the clicked region column highlighted; dim the other region columns.
  cy.nodes('[kind = "edge-location"]').forEach((n) => {
    if (n.id() === regionId) n.addClass("focused");
    else n.addClass("dimmed");
  });

  // Highlight present segment lanes; dim absent ones.
  cy.nodes('[kind = "segment"]').forEach((n) => {
    if (!presentNames.has(n.data("name"))) n.addClass("dimmed");
  });

  showRegionPanel(region, model);
}

// Restore the calm overview: hide routing, un-dim, clear the panel.
function resetFocus() {
  if (!cy) return;
  focusedSegment = null;
  focusedRegion = null; // clear whichever mode was active
  cy.elements().removeClass("shown focused dimmed");
  cy.edges("edge.routing").removeStyle(
    "curve-style control-point-distances control-point-weights"
  );
  closeSidePanel();
}

// --- fan-out for parallel routing edges --------------------------------------

// Spread a set of shown routing edges apart so parallel connectors between the
// same lanes don't stack into one line. Each edge gets `curve-style:
// unbundled-bezier` plus a single control point whose perpendicular distance
// alternates side and grows with the edge's index within THIS focused set:
// index 0 -> 0 (straight), 1 -> +STEP, 2 -> -STEP, 3 -> +2*STEP, ...  The index
// comes from the collection's own order, which is stable for a given model, so
// re-focusing the same segment reproduces the same fan. Styling is applied
// inline (overriding the stylesheet's plain `bezier`) and is stripped again on
// the next focus/region/reset via removeStyle, so it never leaks onto an
// unrelated segment. The dash-flow animation drives `line-dash-offset`, which is
// independent of curve-style, so animated leaks/inspections still flow.
// graph-units between adjacent parallel connectors. Nudged 42 -> 52 alongside
// the wider LANE_GAP (24 -> 48) so the fan spread stays visually proportional
// to the taller inter-lane whitespace. Indexing/side-alternation below is
// unchanged -- only this magnitude moved.
const FAN_STEP = 52;

function fanOutEdges(edges) {
  edges.forEach((edge, i) => {
    // 0, +1, -1, +2, -2, ... -> symmetric spread centered on the straight line.
    const rank = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
    const distance = rank * FAN_STEP;
    edge.style({
      "curve-style": "unbundled-bezier",
      // A single control point at the edge midpoint, pushed `distance` units to
      // one side (sign of `distance` picks the side). rank 0 => 0 => straight.
      "control-point-distances": [distance],
      "control-point-weights": [0.5],
    });
  });
}

// --- info strip --------------------------------------------------------------

export function renderInfoStrip(meta) {
  const strip = document.getElementById("info-strip");
  clear(strip);

  addInfo(strip, "Policy version", meta.version || "n/a");
  addInfo(
    strip,
    "ASN ranges",
    meta.asnRanges.length ? meta.asnRanges.join(", ") : "n/a"
  );
  addInfo(strip, "VPN ECMP", meta.vpnEcmpSupport ? "enabled" : "disabled");
  addInfo(strip, "Edge locations", String(meta.edgeLocationCount));
  addInfo(strip, "Segments", String(meta.segmentCount));
  if (meta.networkFunctionGroupCount > 0) {
    addInfo(strip, "Network function groups", String(meta.networkFunctionGroupCount));
  }
  strip.hidden = false;
}

function addInfo(parent, label, value) {
  const span = document.createElement("span");
  const b = document.createElement("b");
  b.textContent = value; // textContent -> no HTML injection possible
  span.append(label + ": ", b);
  parent.appendChild(span);
}

// --- side panel --------------------------------------------------------------

function showSegmentPanel(seg, model) {
  const meta = model.meta;
  const panel = document.getElementById("side-panel");
  const content = document.getElementById("side-content");
  clear(content);

  const h2 = document.createElement("h2");
  h2.textContent = seg.name;
  content.appendChild(h2);

  if (seg.description) {
    const p = document.createElement("p");
    p.textContent = seg.description;
    content.appendChild(p);
  }

  // Flags
  content.appendChild(heading("Flags"));
  const flags = document.createElement("div");
  flags.appendChild(flagBadge("isolate-attachments", seg.isolateAttachments));
  flags.appendChild(document.createTextNode(" "));
  flags.appendChild(
    flagBadge("require-attachment-acceptance", seg.requireAcceptance)
  );
  content.appendChild(flags);

  // Edge locations this segment spans
  content.appendChild(heading("Edge locations"));
  if (seg.edgeLocations && seg.edgeLocations.length) {
    content.appendChild(list(seg.edgeLocations));
  } else {
    content.appendChild(
      note("No edge-locations listed \u2014 implicitly spans all edge locations.")
    );
  }

  // --- routing derived from the graph edges --------------------------------
  const segNodeId = "seg:" + seg.name;
  const shareOut = []; // bidirectional share partners
  const leaksOut = []; // this segment leaks TO these
  const leaksIn = []; // these segments leak TO this segment
  const routeDests = []; // create-route CIDRs from this segment
  const inspectPaths = []; // inspection path descriptions

  for (const e of model.edges) {
    const d = e.data;
    if (d.kind === "share") {
      if (d.source === segNodeId) shareOut.push(stripSeg(d.target));
      else if (d.target === segNodeId) shareOut.push(stripSeg(d.source));
    } else if (d.kind === "leak") {
      if (d.source === segNodeId) leaksOut.push(stripSeg(d.target));
      else if (d.target === segNodeId) leaksIn.push(stripSeg(d.source));
    }
  }
  for (const n of model.nodes) {
    if (n.data.kind === "route" && n.data.segment === seg.name) {
      const label = n.data.cidrs && n.data.cidrs.length ? n.data.cidrs.join(", ") : "create-route";
      routeDests.push(n.data.blackhole ? label + " (blackhole)" : label);
    }
  }
  for (const ins of meta.inspections) {
    if (ins.fromSegment !== seg.name) continue;
    const modeTag = ins.mode ? ` [${ins.mode}]` : "";
    inspectPaths.push(
      ins.toSegment
        ? `${seg.name} \u2192 ${ins.nfg} \u2192 ${ins.toSegment}${modeTag}`
        : `${seg.name} \u2192 ${ins.nfg} \u2192 egress`
    );
  }

  content.appendChild(heading("Shares with (bidirectional)"));
  content.appendChild(shareOut.length ? list(dedupe(shareOut)) : note("None."));

  if (leaksOut.length || leaksIn.length) {
    content.appendChild(heading("One-way leaks"));
    if (leaksOut.length) content.appendChild(labelledList("Leaks OUT to", dedupe(leaksOut)));
    if (leaksIn.length) content.appendChild(labelledList("Leaked INTO from", dedupe(leaksIn)));
  }

  content.appendChild(heading("Static routes (create-route)"));
  content.appendChild(routeDests.length ? list(routeDests) : note("None."));

  if (inspectPaths.length) {
    content.appendChild(heading("Inspection paths (service insertion)"));
    content.appendChild(list(inspectPaths));
  }

  // Attachment-policy rules that map INTO this segment
  content.appendChild(heading("Attachment rules into this segment"));
  const rules = meta.rulesBySegment[seg.name] || [];
  if (rules.length) {
    for (const rule of rules) {
      content.appendChild(ruleBlock(rule));
    }
  } else {
    content.appendChild(note("No constant-segment attachment rules target this segment."));
  }

  panel.hidden = false;
}

// Region presence panel: the clicked region + ASN, and the segments present in
// it, each annotated with WHY it is present. Mirrors showSegmentPanel and uses
// ONLY createElement + textContent -- region names, ASNs and segment names are
// untrusted policy data, so they must never reach innerHTML.
function showRegionPanel(region, model) {
  const meta = model.meta;
  const panel = document.getElementById("side-panel");
  const content = document.getElementById("side-content");
  clear(content);

  const h2 = document.createElement("h2");
  h2.textContent = region;
  content.appendChild(h2);

  // Region + ASN, pulled from the edge-location node the parser built.
  const edgeNode = model.nodes.find(
    (n) => n.data.kind === "edge-location" && n.data.region === region
  );
  const asn = edgeNode && typeof edgeNode.data.asn === "number" ? edgeNode.data.asn : null;
  content.appendChild(heading("Edge location"));
  content.appendChild(
    list([asn !== null ? `${region} (ASN ${asn})` : `${region} (ASN n/a)`])
  );

  // Segments present here, each with its "why present" reason.
  content.appendChild(heading("Segments present in this region"));
  const present = (meta.segmentsByRegion && meta.segmentsByRegion[region]) || [];
  if (present.length) {
    const ul = document.createElement("ul");
    for (const p of present) {
      const li = document.createElement("li");
      const why =
        p.reason === "spans-all"
          ? "spans all regions"
          : "explicitly scoped to this region";
      // Two textContent nodes: the untrusted segment name, then the reason.
      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name;
      nameSpan.style.fontWeight = "600";
      li.appendChild(nameSpan);
      li.appendChild(document.createTextNode(` \u2014 ${why}`));
      ul.appendChild(li);
    }
    content.appendChild(ul);
  } else {
    content.appendChild(note("No segments are present in this region."));
  }

  panel.hidden = false;
}

// Strip the "seg:" id prefix back to a bare segment name (inverse of segId in
// parser.js). Guards non-string input so callers never crash on odd edge data.
function stripSeg(id) {
  return typeof id === "string" && id.startsWith("seg:") ? id.slice(4) : id;
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

// A sub-labelled list block (all textContent).
function labelledList(label, items) {
  const wrap = document.createElement("div");
  const b = document.createElement("div");
  b.textContent = label;
  b.style.fontWeight = "600";
  b.style.margin = "0.3rem 0 0.1rem";
  wrap.appendChild(b);
  wrap.appendChild(list(items));
  return wrap;
}

// Build the DOM for a single attachment-policy rule (all textContent).
function ruleBlock(rule) {
  const wrap = document.createElement("div");
  wrap.style.margin = "0.4rem 0";

  const title = document.createElement("div");
  const num = rule.ruleNumber !== null ? `Rule #${rule.ruleNumber}` : "Rule";
  const logic = rule.conditionLogic ? ` (${rule.conditionLogic})` : "";
  const method = rule.associationMethod ? ` \u2014 ${rule.associationMethod}` : "";
  title.textContent = num + logic + method;
  title.style.fontWeight = "600";
  wrap.appendChild(title);

  if (rule.conditions.length) {
    const ul = document.createElement("ul");
    for (const c of rule.conditions) {
      const li = document.createElement("li");
      // Compose a readable condition string from parts, all untrusted -> text.
      const parts = [c.type, c.operator, c.key, c.value].filter(Boolean);
      li.textContent = parts.join(" ");
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }
  return wrap;
}

function heading(text) {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

function flagBadge(label, on) {
  const span = document.createElement("span");
  span.className = "badge " + (on ? "on" : "off");
  span.textContent = `${label}: ${on ? "true" : "false"}`;
  return span;
}

function list(items) {
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  }
  return ul;
}

function note(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

export function closeSidePanel() {
  document.getElementById("side-panel").hidden = true;
}

// --- attachment simulator: draw the what-if node on the live graph ----------
//
// These are ADDITIVE: they add/remove one node (+ one link) on the existing cy
// instance built by renderGraph. They deliberately do NOT touch focus/dim state
// or any of the layout helpers, so the simulated node stays visible in every
// mode and re-running renderGraph (which rebuilds cy) simply clears it.
//
// `result` is the object returned by parser.simulateAttachment. `attachment` is
// the raw user input (for the node label). `model` gives us region/segment
// geometry so the node lands in the right column + lane.
const SIM_NODE_ID = "sim:attachment";
const SIM_EDGE_ID = "sim:link";

// Recompute a region's column X the same way buildSwimlaneElements does, WITHOUT
// calling into the protected layout functions. Returns a numeric x (never NaN):
// falls back to the band center if the region is absent from the policy.
function simRegionX(model, region) {
  const regions = model.meta.edgeLocationRegions || [];
  const idx = regions.indexOf(region);
  const laneCenterX = (Math.max(regions.length, 1) - 1) * COL_W * 0.5;
  return idx >= 0 ? idx * COL_W : laneCenterX;
}

// Recompute the winning segment lane's Y (mirror of the protected laneY), by
// index into the ordered segment name list. Returns null if not found.
function simLaneY(model, segmentName) {
  const names = model.meta.segmentNames || [];
  const idx = names.indexOf(segmentName);
  if (idx < 0) return null;
  return BAND_TOP + idx * (LANE_H + LANE_GAP);
}

export function showSimulatedAttachment(model, attachment, result) {
  if (!cy) return;
  clearSimulatedAttachment(); // never stack two

  // A short, safe label. Cytoscape renders labels as plain canvas text (no HTML
  // parsing), and these values are echoed straight from user input, so we keep
  // them as data only -- there is no innerHTML path here.
  const typeStr = attachment.attachmentType || "attachment";
  const regionStr = attachment.region || "no region";
  const label = `VPC (simulated)\n${typeStr} @ ${regionStr}`;

  const associated = typeof result.associatedSegment === "string" && result.associatedSegment;
  // X: the attachment's region column (falls back to band center).
  const x = simRegionX(model, attachment.region);
  // Y: a bit above the winning lane, or high on the canvas if unassociated.
  let y = 68;
  let laneY = null;
  if (associated) {
    laneY = simLaneY(model, result.associatedSegment);
    if (laneY !== null) y = laneY - (LANE_H / 2) - 40;
  }

  cy.add({
    group: "nodes",
    data: { id: SIM_NODE_ID, kind: "sim-attachment", label },
    classes: associated && laneY !== null ? "" : "unassociated",
    position: { x, y },
    grabbable: false,
    selectable: false,
  });

  // Draw the drop-line into the lane only when we actually associated a segment
  // that exists in this rendered model.
  if (associated && laneY !== null) {
    const laneId = "seg:" + result.associatedSegment;
    if (cy.getElementById(laneId).nonempty()) {
      cy.add({
        group: "edges",
        data: { id: SIM_EDGE_ID, source: SIM_NODE_ID, target: laneId, kind: "sim-link" },
        selectable: false,
      });
    }
  }
}

export function clearSimulatedAttachment() {
  if (!cy) return;
  const node = cy.getElementById(SIM_NODE_ID);
  if (node && node.nonempty()) node.remove(); // removing the node drops its edge
  const edge = cy.getElementById(SIM_EDGE_ID);
  if (edge && edge.nonempty()) edge.remove();
}

// --- reachability path highlight: emphasise a checked path on the graph -----
//
// ADDITIVE, like the attachment simulator: highlightReachabilityPath draws the
// hop sequence returned by parser.checkReachability onto the EXISTING cy
// instance, reusing the routing-edge styling + dash-flow. It deliberately does
// NOT call focusSegment/focusRegion/resetFocus (which are protected) -- it
// manages its own dim/highlight classes on a private namespace so it can be
// added and cleared without disturbing click-focus state. Re-running
// renderGraph rebuilds cy and clears everything.
//
// It works by: dimming ALL elements, then adding "path-hop" (undim) to the
// nodes named in the path and drawing NEW `path-edge` connectors between
// consecutive hops (segment lanes, NFG rail nodes, and a dedicated internet
// node). We draw our own edges rather than reveal parser share/leak/inspection
// edges so a multi-hop or egress path renders as one clean animated chain
// regardless of how the underlying relationships were modelled.
const PATH_EDGE_PREFIX = "path-edge:";
const PATH_INTERNET_ID = "path:internet";
let pathDashTimer = null; // dedicated dash-flow timer for the path chain

// Map a reachability hop {hop, kind} to a cy node id already on the graph, or
// create a transient internet node for the "internet" terminal hop. Returns the
// node id, or null if the hop cannot be placed (defensive -- never throws).
function pathHopNodeId(model, hop) {
  if (!cy) return null;
  if (hop.kind === "segment") {
    const id = "seg:" + hop.hop;
    return cy.getElementById(id).nonempty() ? id : null;
  }
  if (hop.kind === "nfg") {
    const id = "nfg:" + hop.hop;
    return cy.getElementById(id).nonempty() ? id : null;
  }
  if (hop.kind === "internet") {
    // Reuse an existing egress node if the graph already drew one; otherwise add
    // a transient internet node to the right of the lanes so the path has a
    // terminal. It carries the same `egress` kind so it inherits the globe icon.
    const existing = cy.nodes('[kind = "egress"]');
    if (existing.nonempty()) return existing[0].id();
    if (cy.getElementById(PATH_INTERNET_ID).nonempty()) return PATH_INTERNET_ID;
    const regions = model.meta.edgeLocationRegions || [];
    const laneCenterX = (Math.max(regions.length, 1) - 1) * 110; // COL_W*0.5
    // Place well to the right of the band center; exact geometry is cosmetic.
    cy.add({
      group: "nodes",
      data: { id: PATH_INTERNET_ID, kind: "egress", label: "internet" },
      classes: "egress-node shown path-hop",
      position: { x: laneCenterX + 640, y: 120 },
      grabbable: false,
      selectable: false,
    });
    return PATH_INTERNET_ID;
  }
  return null;
}

export function highlightReachabilityPath(model, result) {
  if (!cy) return;
  clearReachabilityPath(); // never stack two path highlights

  // Nothing to draw for an unreachable result -- the side panel shows why.
  if (!result || result.reachable !== true || !Array.isArray(result.path)) return;

  // Resolve each hop to a node id on the graph (creating the internet terminal
  // if needed). Skip hops we cannot place rather than aborting the whole chain.
  const hopIds = [];
  for (const hop of result.path) {
    const id = pathHopNodeId(model, hop);
    if (id) hopIds.push(id);
  }
  if (hopIds.length === 0) return;

  // Dim everything, then un-dim the nodes on the path (focus-mode look, but via
  // our own private classes so we never touch the click-focus state machine).
  cy.elements().addClass("path-dim");
  for (const id of hopIds) {
    const n = cy.getElementById(id);
    if (n.nonempty()) {
      n.removeClass("path-dim");
      n.addClass("path-hop shown"); // `shown` reveals nfg/egress helper nodes
    }
  }

  // Draw a fresh directed connector between each consecutive pair of hops.
  for (let i = 0; i < hopIds.length - 1; i++) {
    const source = hopIds[i];
    const target = hopIds[i + 1];
    cy.add({
      group: "edges",
      data: { id: PATH_EDGE_PREFIX + i, source, target, kind: "path" },
      classes: "path-edge",
      selectable: false,
    });
  }

  // Animate the path connectors so the direction of flow is obvious, matching
  // the routing-edge dash-flow feel. Cleared in clearReachabilityPath.
  let off = 0;
  pathDashTimer = setInterval(() => {
    if (!cy) return;
    off = (off - 12) % 1000;
    cy.edges("edge.path-edge").style("line-dash-offset", off);
  }, 90);
}

export function clearReachabilityPath() {
  if (pathDashTimer) {
    clearInterval(pathDashTimer);
    pathDashTimer = null;
  }
  if (!cy) return;
  cy.edges("edge.path-edge").remove();
  const internet = cy.getElementById(PATH_INTERNET_ID);
  if (internet && internet.nonempty()) internet.remove();
  cy.elements().removeClass("path-dim path-hop");
}

// --- graph teardown: blank the canvas when switching modes ------------------
//
// ADDITIVE teardown, used by app.js's setMode() so a graph drawn in one mode
// does not linger on the canvas when the user switches to another. It performs
// exactly the same instance + timer teardown renderGraph() already does at the
// top of a redraw, factored into a callable so the canvas can be cleared
// WITHOUT drawing a new model (e.g. entering live mode before any policy is
// fetched). It changes no rendering logic -- it only tears down.
export function clearGraph() {
  if (cy) {
    cy.destroy();
    cy = null;
  }
  if (dashTimer) {
    clearInterval(dashTimer);
    dashTimer = null;
  }
  if (pathDashTimer) {
    clearInterval(pathDashTimer);
    pathDashTimer = null;
  }
  focusedSegment = null;
  focusedRegion = null;
}

// Remove all children without touching innerHTML.
function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

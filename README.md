# Cloud WAN Policy Visualizer — native macOS app (Tauri v2)

A double-clickable, **fully offline** macOS wrapper around the existing client-side
Cloud WAN policy visualizer. It is **packaging, not a rewrite**: the web PoC in
`../cloudwan-policy-viz/` runs unchanged as the frontend, rendered in a native
window via **Tauri v2** — which uses the operating system's own WebView (WKWebView),
**not** a bundled Chromium, so the `.app` is ~12 MB rather than hundreds. In its
default **Offline / simulate** mode it makes **zero network requests**; Cytoscape.js
is vendored locally. An opt-in **Read live state** mode adds read-only calls to AWS
Network Manager — issued by the Rust layer via the `aws` CLI, never by the webview
(see *[Read live state](#read-live-state-live-aws-mode)*).

The standalone browser version at `../cloudwan-policy-viz/` remains the reference.
The swimlane view, click-to-explore routing, region filter, attachment simulator,
and reachability checker are identical between the two builds; the native app adds a
native *file-open path*, a vendored *Cytoscape source*, and the native-only live AWS
mode (the web build stays simulation-only).

> **⚠️ Disclaimer — read this first**
>
> This is a **demonstration / proof-of-concept** tool, provided for **educational
> and illustrative purposes only**.
>
> **There is no guarantee that anything it shows is correct.** The visualizations,
> attachment-simulation results, reachability verdicts, and any other output may be
> **inaccurate, incomplete, or out of date**, and may diverge from how AWS Cloud WAN
> actually behaves. The tool models Cloud WAN policy behaviour on a **best-effort
> basis only**.
>
> **Do not rely on it** for production decisions, security assessments, compliance,
> or as a source of truth about a real network. Always verify against the **AWS
> console**, the **official AWS documentation**, and your own analysis.
>
> **Not an AWS product.** This is a personal project. It is **not** an official
> Amazon or AWS product, and is **not endorsed by, sponsored by, or affiliated
> with** Amazon Web Services. Although the author works at AWS, this is a personal
> publication and any views or output are the author's own.
>
> **Provided "AS IS".** The software is provided *"AS IS"*, without warranty of any
> kind, express or implied. See [License](#license).

**Status:** demo / proof-of-concept — published for illustration, not maintained as
a product.

## Read live state (live AWS mode)

> **Native-app only.** This mode exists solely in the macOS app. The standalone
> browser build at `../cloudwan-policy-viz/` stays simulation-only and makes no
> AWS calls — a browser/webview never gets credentials.

At startup the app now offers two modes in the controls row:

- **Offline / simulate** — the existing flow: load or paste a policy JSON and
  explore it. Nothing touches AWS.
- **Read live state…** — fetch the **deployed** configuration straight from AWS
  Network Manager and visualize it through the *same* pipeline (topology,
  routing, attachment simulator, reachability checker all work on live data).

A permanent **READ-ONLY** badge is shown in the header whenever the app can reach
AWS, as an unmissable reminder that this mode only ever reads.

### What it does

In live mode you pick a named AWS CLI **profile** (from `~/.aws/config`) and a
**region**, then work in two stages:

1. **List core networks → Fetch live policy.** `list-core-networks` populates a
   picker; choosing one and fetching runs `get-core-network-policy`, and the
   returned **deployed** policy document renders through the existing parser —
   identically to a file-loaded or pasted policy.
2. **Overlay deployed routes (optional).** For one segment edge — a
   *segment + edge-location + route type (propagated/static)* — `get-network-routes`
   fetches the live route table. The reachability checker then shows a second,
   clearly-labelled **DEPLOYED-ROUTES** verdict beneath the **POLICY INTENT**
   verdict, so you can see where the policy permits a path but the live table
   blackholes or omits it.

> **Policy intent vs deployed routes — two different things.** The fetched
> policy is still *intent* (just the real, deployed intent), while
> `get-network-routes` returns the actual data-plane route tables. The
> reachability checker labels which of the two a verdict came from and never
> conflates them.

### Prerequisites

- **AWS CLI installed and signed in.** Live mode shells out to your existing
  `aws` binary; the app holds and stores **no** credentials. Sign in the normal
  way, e.g. `aws sso login --profile <name>`.
- **A named profile with read access to Network Manager.** The profile needs
  only read permissions — `networkmanager:Get*`, `networkmanager:List*`, and
  `networkmanager:Describe*` are sufficient (Network Manager is a global service,
  so its control-plane calls resolve in `us-west-2` regardless of the region you
  type; a broad read profile such as an SSO ReadOnly role works fine).

No extra setup, no app configuration, no stored secrets — the app relies entirely
on your CLI profiles/SSO.

### How to use it

1. Launch the app and click **Read live state…** in the controls row.
2. Pick an **AWS profile** and enter a **Region** (e.g. `eu-west-1`), then
   **List core networks**.
3. Pick a **core network** and **Fetch live policy** — the deployed topology
   renders.
4. *(Optional)* Pick a **segment**, **edge location**, and **route type**, then
   **Fetch deployed routes** to overlay the live route table. Open **Check
   reachability** to see the DEPLOYED-ROUTES verdict alongside POLICY INTENT.
   **Clear routes overlay** (or switching back to Offline) drops the overlay so a
   later check never silently mixes in stale live data.

If the AWS CLI is missing or your SSO session has expired, the app surfaces a
friendly banner (e.g. *"AWS credentials look expired. Run `aws sso login …`"*)
and never crashes.

### Read-only by design

Live mode is **designed to be read-only**, enforced in depth in
`src-tauri/src/aws.rs`:

- **Read-only by construction.** All AWS access goes through a **closed allowlist
  of read-only subcommands** — `describe-global-networks`, `list-core-networks`,
  `get-core-network-policy`, `get-network-routes`, `list-attachments`,
  `get-vpc-attachment` (the last three are a reserved read-only surface; the UI
  currently wires the middle three). The subcommand for each call is chosen in
  **Rust from an enum — never from the frontend** — so there is no code path,
  even via a bug, that can construct a `create`/`update`/`delete`/any mutating
  call. The allowlist enum has no `Other(String)` escape hatch, and a
  **build-time unit test fails the build** if a mutating verb is ever added.
- **CLI + named profiles, no stored credentials.** `aws` is invoked with an
  explicit `--profile` (the one you pick) and `--region`. The app holds no
  credentials and stores nothing; it relies entirely on your existing CLI
  profiles/SSO.
- **No credential access.** Profile discovery reads only the `[profile NAME]`
  header *names* from `~/.aws/config`. It never reads `~/.aws/credentials` and
  never touches any secret/key/token value.
- **Safe invocation — no shell, no injection.** `aws` is spawned directly via
  `std::process::Command` with an **argv array**, never a shell string. Every
  caller-supplied value (profile, region, ids, segment, edge, route type) is
  validated against strict character allowlists that reject shell metacharacters,
  so an id containing `;` or `$(…)` is just a literal argument the CLI rejects.
- **Network posture unchanged.** The webview still makes **zero** direct network
  calls — the CSP `connect-src 'self'` blocks egress — and *all* AWS traffic goes
  through the Rust command layer. Capabilities remain least-privilege
  (`dialog:allow-open` + `fs:allow-read-text-file` only; **no shell plugin** —
  `aws` is spawned directly from Rust, not exposed to the webview). The app is
  otherwise fully offline (vendored Cytoscape).

### How it fits together (architecture note)

The live surface is deliberately quarantined so a customer can diff web-vs-native
and confirm the parsing/rendering logic is untouched:

- **`src-tauri/src/aws.rs`** — the read-only command layer. Flow:
  `ReadOnlySubcommand` enum (server-chosen verb) → `build_argv(...)` (validates
  profile/region/ids, assembles the exact `networkmanager … --profile … --region
  … --output json` argv) → `run_aws(...)` (`std::process::Command`, argv array).
  The Tauri commands `list_profiles`, `list_core_networks`, `get_live_policy`,
  and `get_live_routes` are the *entire* AWS surface the frontend can reach; each
  returns raw JSON text. `get_live_routes` builds a full
  `CoreNetworkSegmentEdge` route-table identifier (CoreNetworkId + SegmentName +
  EdgeLocation) because a Cloud WAN segment route table is per-segment-per-edge —
  a core-network id alone is insufficient.
- **`frontend/live.js`** — the only frontend file that talks to AWS, and only via
  those named commands. It injects the mode picker, READ-ONLY badge, and live
  panel under Tauri; in a plain browser (`window.__TAURI__` absent) it does
  nothing and the app is the ordinary offline visualizer. Every value returned
  from AWS is rendered with `createElement`/`textContent` only — no `innerHTML`,
  no `eval`. Fetched routes are normalized (`normalizeLiveRoutes`) and handed to
  the reachability layer as the DEPLOYED-ROUTES overlay.

### Verification status (live mode)

- `cargo check` is clean; the **8 Rust unit tests** in `aws.rs` pass (argv shape,
  the exhaustive read-only-verb guard, and shell-injection rejection for
  profile/region/id/segment/edge/route-scope), as do the data-plane JS tests.
- **The end-to-end live flow has NOT been run against a real AWS account** by the
  build crew (no AWS-connected GUI automation). Before demoing, run it once
  against your own account — e.g. profile for **lab1c** in **eu-west-1** — to
  confirm: profiles list, core networks list, live policy renders, and a deployed
  routes overlay produces a DEPLOYED-ROUTES verdict.

## What's here

```
frontend/            Copy of the web PoC (index.html, parser.js, render.js, app.js,
                     example.js, style.css, samples/). Byte-identical to the web
                     build EXCEPT:
  index.html         - loads vendor/cytoscape.min.js locally instead of the CDN
  app.js             - one added line exposing window.__visualizeFromText
  native.js          - NEW: thin shim wiring "Open .json..." to the macOS dialog
  live.js            - NEW: NATIVE-ONLY glue for "Read live state" mode; talks to
                       AWS only through the read-only Tauri commands in aws.rs
                       (no-op in a plain browser)
  vendor/            - vendored Cytoscape 3.30.2 (SHA-384 verified vs the CDN)
src-tauri/           Tauri v2 Rust shell (main.rs/lib.rs), tauri.conf.json,
                     capabilities/default.json, icons/
  src/aws.rs         - NEW: read-only AWS Network Manager command layer for live
                       mode (closed allowlist of get/list/describe verbs)
```

## Run the built app

Open the produced bundle:

```
open "src-tauri/target/release/bundle/macos/Cloud WAN Policy Visualizer.app"
```

It is **unsigned** (by design — local use only). On first launch macOS Gatekeeper
may warn; right-click the app → **Open** and confirm, or run
`xattr -dr com.apple.quarantine "<app path>"`.

## Rebuild from source

Prereqs (**build-time only** — the produced `.app` needs none of these to run):
Rust toolchain via `rustup` (`rustc`/`cargo`), Xcode Command Line Tools, and the
Tauri v2 CLI (`cargo install tauri-cli --version "^2.0"`).

```
cd src-tauri
cargo tauri build            # release .app + .dmg
# or, faster during development:
cargo tauri dev              # hot-run the app, live-reload the frontend
cargo tauri build --debug    # unoptimized bundle
```

> The **first** `cargo tauri build` compiles the whole Tauri/Rust dependency tree
> (many crates) and can take several minutes. Later builds are incremental and fast.

Output bundles (Apple Silicon / `aarch64`):

- `.app` — `src-tauri/target/release/bundle/macos/Cloud WAN Policy Visualizer.app`
- `.dmg` — `src-tauri/target/release/bundle/dmg/Cloud WAN Policy Visualizer_0.1.0_aarch64.dmg`

## Security choices to KEEP if you adapt this

These are the deliberate least-privilege decisions — do not loosen them without a
reason:

- **Capabilities are read-only + dialog-only.** `src-tauri/capabilities/default.json`
  grants exactly two permissions: `dialog:allow-open` and `fs:allow-read-text-file`
  scoped to `$FILE` (only the file the user picks). There is **no** shell, **no**
  network/http, **no** filesystem write, and **no** broad directory scope.
- **Fully offline.** Cytoscape is vendored (`frontend/vendor/cytoscape.min.js`) and
  verified byte-for-byte against the pinned CDN SHA-384 at vendor time. The CSP in
  `tauri.conf.json` pins every fetch to the app itself —
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`
  — so there is no remote origin and `connect-src 'self'` blocks all network egress.
  (Because scripts are vendored and served from `'self'`, no runtime SRI is needed.)
  This webview egress block is **unchanged by live mode**: live mode's AWS traffic
  is made by the `aws` CLI subprocess spawned from Rust, not by the WebView — the
  webview itself still reaches nothing but the app.
- **Minimal, read-only IPC surface.** The Rust shell registers the dialog and fs
  plugins plus **four custom `#[tauri::command]` functions for live mode**
  (`list_profiles`, `list_core_networks`, `get_live_policy`, `get_live_routes`) —
  and nothing else. All four are read-only by construction (see
  *[Read-only by design](#read-only-by-design)*): the AWS verb is chosen in Rust
  from a closed allowlist, never from the frontend, and there is no write path.
  In the default offline build these commands are simply never invoked.
- **Policy JSON never leaves the machine.** All parsing/rendering is client-side
  (unchanged from the web PoC); the native path only *reads* the chosen file's text
  and hands it to the same in-browser parser. No upload, no `eval`, no `innerHTML`;
  the DOM is built via `textContent`/`createElement`.
- **Unsigned, local-use bundle.** No code-signing or notarization is configured, so
  Gatekeeper warns on first launch (see *Run the built app*). Distributing the app to
  others *without* those warnings would require Apple **code signing + notarization** —
  a documented future step, intentionally not done for this PoC.
- **`reqwest`/`hyper` in `Cargo.lock` are transitive Tauri deps, not an egress path.**
  You will see `reqwest` and `hyper` (an HTTP client/stack) in `Cargo.lock`. These are
  pulled in **internally by the Tauri 2.x framework**, not added by this app. The app's
  own declared dependencies are only `tauri`, `tauri-plugin-dialog`, `tauri-plugin-fs`,
  and `serde` (+ `serde_json`, a serializer — *not* a network client). There is **no**
  `tauri-plugin-http`, **no** updater configured, and the webview CSP is
  `connect-src 'self'`, so this HTTP stack is **not reachable** from the app or the
  webview and is **not** an egress path. All live-mode AWS traffic is made by the `aws`
  CLI subprocess spawned from Rust, never by an in-app HTTP client.

To re-vet the vendored dependency:

```
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
# must equal: IWROdLKRsN1UuJywMlWl7/blXQ8GEooN2n7dzTxfEPd7ybYIKCUJ2Ol/1Gpf3YV4
```

## Verification status

The app **builds** (`cargo tauri build` produced the `.app` and `.dmg` above) and
the binary **launches**. The build crew has no GUI automation, so the on-screen
render was **not** machine-verified. Before demoing, a human should launch the app
once and confirm:

1. A policy renders — load one of the bundled `frontend/samples/*.json` via
   **Open .json…**, or the baked-in example.
2. The native macOS open panel appears for **Open .json…** (not the browser's
   file input).
3. **Zero network requests** — open the WebView DevTools (right-click → *Inspect
   Element* in a debug build) and confirm the Network tab stays empty.

## License

Licensed under the **Apache License, Version 2.0**. The source files carry
Apache-2.0 headers, and the full license text is in the top-level
[`LICENSE`](./LICENSE) file.

The software is provided **"AS IS"**, without warranty of any kind, express or
implied; see the Disclaimer at the top of this README and the license text for
details.

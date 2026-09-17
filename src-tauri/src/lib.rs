// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License").
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Native macOS shell for the Cloud WAN policy visualizer.
//!
//! The application is the existing static web frontend (index.html + the
//! visualizer's own JS/CSS), which Tauri serves from the bundled `frontend/`
//! directory. Two small, tightly-scoped native surfaces exist:
//!
//! * the file-dialog + filesystem-read plugins, so the "Open .json..." button
//!   can use the real macOS open panel (unchanged from the original app); and
//! * a handful of READ-ONLY AWS commands in [`aws`], for the "Read live state"
//!   mode. These spawn the `aws` CLI directly (no shell plugin), can only run a
//!   fixed allowlist of Network Manager `get`/`list`/`describe` subcommands,
//!   and validate every caller-supplied value. See `aws.rs` for the full
//!   read-only-by-construction argument.
//!
//! There is still NO `tauri-plugin-shell` (the frontend cannot invoke an
//! arbitrary executable), NO filesystem WRITE, and NO webview network access
//! (all AWS traffic goes through the Rust CLI layer, not the webview).

mod aws;

pub fn run() {
    tauri::Builder::default()
        // Native file open/save dialogs. We only USE `open` from the frontend;
        // the capability file (capabilities/default.json) is what actually
        // grants permission, and it grants dialog:allow-open only.
        .plugin(tauri_plugin_dialog::init())
        // Filesystem plugin. Again, the capability file narrows this down to
        // reading the single file the user picks -- no write, no directory scope.
        .plugin(tauri_plugin_fs::init())
        // READ-ONLY AWS commands for "Read live state" mode. Each is read-only
        // by construction: the AWS verb is chosen in Rust from a fixed
        // allowlist, never from the frontend, and args are validated + passed
        // as a spawned-process array (never a shell string). No mutating call
        // can be built. Registering commands here does not, by itself, grant
        // the webview anything beyond calling these named functions.
        .invoke_handler(tauri::generate_handler![
            aws::list_profiles,
            aws::list_core_networks,
            aws::get_live_policy,
            aws::get_live_routes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Cloud WAN visualizer app");
}

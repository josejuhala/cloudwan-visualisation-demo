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
 * native.js -- NATIVE-APP ONLY glue for the Tauri v2 build.
 *
 * The visualizer's own logic (parser.js / render.js / app.js) is byte-for-byte
 * the same as the standalone web PoC. This file is the ONE addition for the
 * packaged .app: it upgrades the "Open .json..." button to the real macOS file
 * dialog instead of the browser's <input type=file>.
 *
 * Why a separate file (not an edit to app.js): keeping app.js identical to the
 * web build means a customer can diff the two and see that the parsing/rendering
 * logic is untouched -- only this thin, clearly-labelled shim is new.
 *
 * Graceful degradation: if the Tauri API is not present (e.g. the same files
 * opened in a plain browser), this does nothing and app.js's built-in
 * FileReader path handles "Open .json..." exactly as before.
 *
 * Security: uses ONLY the Tauri dialog(open) + fs read plugins, scoped in
 * capabilities/default.json to the single file the user explicitly picks. There
 * is no shell, no network, and no fs write. The chosen file is read as text and
 * handed to the SAME parse path (window.__visualizeFromText) the web build uses;
 * nothing ever leaves the machine.
 */

// Tauri v2 exposes its API on window.__TAURI__ when withGlobalTauri is enabled.
// Its absence is the signal that we are in a plain browser -> do nothing.
const tauri = window.__TAURI__;
if (tauri && tauri.dialog && tauri.fs) {
  const { open } = tauri.dialog;
  const { readTextFile } = tauri.fs;

  // The web markup wraps a hidden <input type=file> in a <label class="file-btn">.
  // Under Tauri we bypass that input entirely and drive the native dialog. We
  // stop the label's default behaviour so the hidden input never opens too.
  const label = document.querySelector("label.file-btn");
  const fileInput = document.getElementById("file-input");

  async function openNative() {
    try {
      // Native macOS open panel, restricted to JSON. Single file only.
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "JSON policy", extensions: ["json"] }],
      });
      if (!selected) return; // user cancelled

      // `open` returns a string path (single-select). Read it as text via the
      // fs plugin -- the capability scopes this to the file the user just chose.
      const path = Array.isArray(selected) ? selected[0] : selected;
      const text = await readTextFile(path);

      // Hand off to the exact same safe parse+render path the web build uses.
      if (typeof window.__visualizeFromText === "function") {
        window.__visualizeFromText(text);
      }
    } catch (err) {
      // Surface as the app's own friendly banner if available; never throw.
      const banner = document.getElementById("error-banner");
      if (banner) {
        banner.textContent = "Could not open that file: " + (err && err.message ? err.message : String(err));
        banner.hidden = false;
      }
    }
  }

  if (label) {
    // Remove the hidden browser input so only the native dialog is used, and
    // make the label itself the trigger.
    if (fileInput) fileInput.remove();
    label.addEventListener("click", (e) => {
      e.preventDefault();
      openNative();
    });
    label.style.cursor = "pointer";
  }
}

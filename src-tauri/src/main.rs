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

// Prevent an extra console window on Windows in release. Harmless on macOS,
// kept so the same source builds cleanly if ever retargeted.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cloudwan_policy_viz_app_lib::run()
}

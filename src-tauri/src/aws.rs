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

//! Read-only AWS Network Manager access for the "Read live state" mode.
//!
//! # Why this is safe by construction (read this first)
//!
//! The single most important property of this file is that it can ONLY ever
//! run read-only `aws networkmanager` commands. That is enforced in depth:
//!
//! 1. **The verb is chosen HERE, not by the frontend.** Every public command
//!    below hands a fixed [`ReadOnlySubcommand`] enum variant to the argv
//!    builder. The webview passes *parameters only* -- a profile, a region,
//!    some ids -- and can never name the subcommand. There is no code path in
//!    which a string from JavaScript becomes the AWS verb.
//!
//! 2. **The allowlist is exhaustive and read-only.** [`ReadOnlySubcommand`]
//!    lists exactly six `get`/`list`/`describe` subcommands. There is no
//!    variant for any `create`/`update`/`delete`/`put`/`modify`/`associate`/
//!    `register`/`deregister`/`start`/`tag` verb, so no mutating call can be
//!    constructed even by a bug elsewhere in this crate.
//!
//! 3. **argv is an array, never a shell string.** We spawn the `aws` binary
//!    directly with [`std::process::Command`] and pass each token as a separate
//!    `arg(...)`. Nothing is handed to a shell, so there is no interpolation,
//!    quoting, or injection surface -- an id containing `;` or `$(...)` is just
//!    a literal argument that the AWS CLI rejects.
//!
//! 4. **Every caller-supplied value is validated before use.** Profile, region
//!    and ids are checked against tight character allowlists and rejected
//!    otherwise (see [`validate_profile`], [`validate_region`], [`validate_id`]).
//!
//! 5. **The profile is always explicit.** We never rely on ambient/default
//!    credentials; the user picks a named CLI profile and we always pass
//!    `--profile <that>`. The app itself holds no credentials.
//!
//! We deliberately do NOT use `tauri-plugin-shell`: that plugin exists to let
//! the *frontend* invoke executables, which is exactly the capability we do not
//! want to expose. Keeping the process spawn inside these Rust commands means
//! the webview's entire AWS surface is these few read-only functions -- it has
//! no shell verb to reach at all.

use std::process::Command;

/// Fixed allowlist of ABSOLUTE paths where the `aws` CLI is expected to live,
/// tried in order. This is deliberately a small closed list of known install
/// locations, NOT a broad "find anything named aws on PATH" search.
///
/// # Why a fixed absolute-path list (read this)
///
/// A macOS GUI app launched from Finder/Gatekeeper does NOT inherit the user's
/// shell `PATH`. It starts with a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:
/// /sbin`) that excludes `/usr/local/bin` and `/opt/homebrew/bin`, which is
/// exactly where the AWS CLI installs. So `Command::new("aws")` -- which relies
/// on `PATH` -- fails with "not found" from the .app even though `aws` is on the
/// user's terminal `PATH`. We resolve to a known absolute path instead.
///
/// SECURITY: this does not weaken the read-only guarantee. WHICH binary path we
/// exec changes; the verb is still server-chosen from [`ReadOnlySubcommand`],
/// argv is still an array, and the validators are unchanged. The candidates are
/// standard vendor install locations, and the only user-controlled input is an
/// explicit `AWS_CLI_PATH` override the user sets themselves.
const AWS_BIN_CANDIDATES: &[&str] = &[
    "/usr/local/bin/aws",   // Intel Homebrew / official AWS pkg (user's location)
    "/opt/homebrew/bin/aws", // Apple Silicon Homebrew
    "/usr/bin/aws",
];

/// Env var a user can set to point at a nonstandard `aws` install. Takes
/// precedence over the fixed candidates when set to an existing executable.
const AWS_CLI_PATH_ENV: &str = "AWS_CLI_PATH";

/// PATH prepended to the child AWS CLI process so its OWN subprocess/SSO
/// resolution works under the minimal GUI PATH. The CLI may shell out (e.g. a
/// `credential_process`, browser launch for SSO) and needs these dirs on PATH.
const CHILD_PATH_PREPEND: &str = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";

/// Resolve the `aws` binary to an absolute path from a fixed candidate list,
/// honouring an explicit override first, then falling back to a bare-name
/// `PATH` lookup so a terminal-launched dev build still works.
///
/// Pure and injectable: the caller passes the override value, the candidate
/// list, and a predicate that decides whether a given path is a usable
/// executable. This lets the unit test drive it against a temp file without
/// depending on the machine's real filesystem layout or a real `aws` binary.
///
/// Returns the resolved absolute path, or `None` (bare `"aws"` fallback is the
/// caller's decision, kept out of here so the resolver stays deterministic).
fn resolve_aws_bin<F>(
    override_path: Option<&str>,
    candidates: &[&str],
    is_usable: F,
) -> Option<String>
where
    F: Fn(&str) -> bool,
{
    // 1. Explicit override wins, but only if it actually points at a usable file.
    if let Some(p) = override_path {
        if !p.is_empty() && is_usable(p) {
            return Some(p.to_string());
        }
    }
    // 2. First fixed absolute candidate that exists and is executable.
    candidates
        .iter()
        .find(|c| is_usable(c))
        .map(|c| c.to_string())
}

/// Real-filesystem predicate: true if `path` is an existing, executable file.
/// On unix we check the mode bits; the resolver treats a non-executable match
/// as "not usable" and moves on to the next candidate.
fn path_is_executable(path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(m) => m.is_file() && (m.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

/// The absolute `aws` path to spawn, resolved for the current process. Uses the
/// `AWS_CLI_PATH` override, then the fixed candidates; falls back to the bare
/// name `"aws"` (PATH lookup) only if none resolved, so a dev build launched
/// from a terminal -- which DOES inherit PATH -- still works.
fn aws_bin() -> String {
    let override_path = std::env::var(AWS_CLI_PATH_ENV).ok();
    resolve_aws_bin(
        override_path.as_deref(),
        AWS_BIN_CANDIDATES,
        path_is_executable,
    )
    .unwrap_or_else(|| "aws".to_string())
}

/// The complete, exhaustive allowlist of AWS subcommands this app may run.
///
/// Every variant is a read-only `get`/`list`/`describe` Network Manager call.
/// Adding a mutating verb here would be the only way to make this app write to
/// AWS -- so this enum is the one place to audit. There is intentionally no
/// `Other(String)` escape hatch: an unknown verb is unrepresentable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadOnlySubcommand {
    // These three are part of the read-only allowlist and are exercised by the
    // `every_allowlisted_subcommand_is_read_only` test, but no Tauri command
    // wires them to the UI yet. `allow(dead_code)` documents that they are a
    // reserved, deliberately read-only surface rather than an oversight.
    #[allow(dead_code)]
    DescribeGlobalNetworks,
    ListCoreNetworks,
    GetCoreNetworkPolicy,
    GetNetworkRoutes,
    #[allow(dead_code)]
    ListAttachments,
    #[allow(dead_code)]
    GetVpcAttachment,
}

impl ReadOnlySubcommand {
    /// The literal CLI subcommand token. Read-only verbs only.
    fn as_str(self) -> &'static str {
        match self {
            ReadOnlySubcommand::DescribeGlobalNetworks => "describe-global-networks",
            ReadOnlySubcommand::ListCoreNetworks => "list-core-networks",
            ReadOnlySubcommand::GetCoreNetworkPolicy => "get-core-network-policy",
            ReadOnlySubcommand::GetNetworkRoutes => "get-network-routes",
            ReadOnlySubcommand::ListAttachments => "list-attachments",
            ReadOnlySubcommand::GetVpcAttachment => "get-vpc-attachment",
        }
    }
}

/// A validation / execution error, rendered as a friendly string for the UI.
#[derive(Debug)]
pub struct AwsError(String);

impl std::fmt::Display for AwsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AwsError {}

// Tauri needs command errors to be serializable to hand them to the frontend.
impl serde::Serialize for AwsError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

/// A validated AWS CLI profile name. Allowed characters mirror what the AWS CLI
/// itself accepts for profile names; anything else is rejected before use.
fn validate_profile(profile: &str) -> Result<&str, AwsError> {
    if profile.is_empty() || profile.len() > 128 {
        return Err(AwsError("Profile name is empty or too long.".into()));
    }
    // ^[A-Za-z0-9_.:=+/@-]+$
    let ok = profile
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_.:=+/@-".contains(c));
    if ok {
        Ok(profile)
    } else {
        Err(AwsError(format!(
            "Profile name \"{profile}\" contains characters that are not allowed."
        )))
    }
}

/// A validated AWS region. `^[a-z0-9-]+$` -- e.g. `eu-west-1`.
fn validate_region(region: &str) -> Result<&str, AwsError> {
    if region.is_empty() || region.len() > 32 {
        return Err(AwsError("Region is empty or too long.".into()));
    }
    let ok = region
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(region)
    } else {
        Err(AwsError(format!(
            "Region \"{region}\" contains characters that are not allowed."
        )))
    }
}

/// A validated resource id (core-network id, attachment id, etc). Character set
/// covers real AWS ids and ARNs: alphanumerics plus `-`, `_`, `:`, `/`, `.`.
/// Deliberately rejects whitespace, quotes, `;`, `$`, `&`, `|`, `` ` ``, so an
/// id can never smuggle a second token even if it somehow reached a shell.
fn validate_id(id: &str, what: &str) -> Result<String, AwsError> {
    if id.is_empty() || id.len() > 256 {
        return Err(AwsError(format!("{what} is empty or too long.")));
    }
    let ok = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_:/.".contains(c));
    if ok {
        Ok(id.to_string())
    } else {
        Err(AwsError(format!(
            "{what} \"{id}\" contains characters that are not allowed."
        )))
    }
}

/// One of the small set of route scopes `get-network-routes` accepts. We map a
/// frontend string onto a fixed value rather than pass it through, so this is a
/// closed allowlist too. The AWS API's `--types` enum is `PROPAGATED`/`STATIC`.
fn validate_route_scope(scope: &str) -> Result<&'static str, AwsError> {
    match scope {
        "propagated" => Ok("PROPAGATED"),
        "static" => Ok("STATIC"),
        _ => Err(AwsError(format!(
            "Unknown route scope \"{scope}\" (expected \"propagated\" or \"static\")."
        ))),
    }
}

/// A validated segment name. Cloud WAN segment names are alphanumerics only
/// (the policy schema requires `^[a-zA-Z0-9]{1,64}$`), so this is a tight set
/// that also happens to reject every shell metacharacter.
fn validate_segment_name(name: &str) -> Result<String, AwsError> {
    if name.is_empty() || name.len() > 64 {
        return Err(AwsError("Segment name is empty or too long.".into()));
    }
    if name.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(name.to_string())
    } else {
        Err(AwsError(format!(
            "Segment name \"{name}\" contains characters that are not allowed."
        )))
    }
}

/// A validated edge location (an AWS Region, e.g. `eu-west-1`). Same shape as a
/// region, but a distinct helper keeps the error message meaningful.
fn validate_edge_location(edge: &str) -> Result<String, AwsError> {
    validate_region(edge)
        .map(|s| s.to_string())
        .map_err(|_| AwsError(format!("Edge location \"{edge}\" is not a valid Region.")))
}

/// Build the exact argv for a read-only Network Manager call.
///
/// The subcommand comes from the [`ReadOnlySubcommand`] enum (server-chosen,
/// never from the frontend). `profile` and `region` are validated here. `extra`
/// carries already-validated flag/value pairs specific to the call. The result
/// always begins `["networkmanager", <sub>, "--profile", .., "--region", ..,
/// "--output", "json"]` so every call is scoped to a named profile and returns
/// JSON.
///
/// This function is pure (no I/O), which is what makes it unit-testable without
/// AWS: a test can assert the argv for valid input and assert rejection for a
/// malformed profile/region/id or an injection attempt.
fn build_argv(
    sub: ReadOnlySubcommand,
    profile: &str,
    region: &str,
    extra: &[String],
) -> Result<Vec<String>, AwsError> {
    let profile = validate_profile(profile)?;
    let region = validate_region(region)?;
    let mut argv = vec![
        "networkmanager".to_string(),
        sub.as_str().to_string(),
        "--profile".to_string(),
        profile.to_string(),
        "--region".to_string(),
        region.to_string(),
        "--output".to_string(),
        "json".to_string(),
    ];
    argv.extend_from_slice(extra);
    Ok(argv)
}

/// Spawn `aws` with the given argv (array items, never a shell string) and
/// return stdout on success. Non-zero exit, a missing binary, or expired SSO
/// all map to a friendly `AwsError` -- the caller surfaces it as UI text and
/// the app never crashes.
fn run_aws(argv: &[String]) -> Result<String, AwsError> {
    // Resolve to an absolute path (see `resolve_aws_bin`): a Finder-launched
    // .app does not inherit the shell PATH, so the bare name would not be found.
    let bin = aws_bin();

    // Augment the CHILD's PATH so the AWS CLI's own subprocess/SSO resolution
    // works under the minimal GUI PATH. We PREPEND the standard bin dirs to any
    // inherited PATH so the CLI can still find its own helpers (browser launch
    // for SSO, a `credential_process`, etc.).
    let child_path = match std::env::var("PATH") {
        Ok(existing) if !existing.is_empty() => format!("{CHILD_PATH_PREPEND}:{existing}"),
        _ => CHILD_PATH_PREPEND.to_string(),
    };

    // HARDENING (L1): start from an EMPTY child environment and set back only
    // the curated variables the AWS CLI genuinely needs. This drops every
    // UNRELATED parent env var (tokens, editor state, ephemeral desktop-session
    // vars, etc.) from the CLI subprocess without starving its profile/SSO
    // resolution. It does NOT change the read-only guarantee -- the verb is
    // still server-chosen, argv is still an array, validators are untouched.
    //
    // Why each retained var is kept:
    //   PATH  -- the prepended bin dirs + inherited PATH, so the CLI can find
    //            its own subprocess helpers (SSO browser launch, credential_process).
    //   HOME  -- the CLI reads ~/.aws/config, ~/.aws/credentials, and the SSO
    //            token cache under ~/.aws/sso/cache relative to HOME. Without it
    //            `aws sso` profiles cannot resolve their cached token -> would break SSO.
    //   AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE -- honour a non-default
    //            config/credentials location if the user set one.
    //   AWS_PROFILE -- respected as a fallback; we still pass --profile explicitly.
    //   AWS_REGION / AWS_DEFAULT_REGION -- region fallbacks; we pass --region too.
    //   AWS_CA_BUNDLE -- custom TLS trust store (corporate proxies) so HTTPS still verifies.
    //   AWS_STS_REGIONAL_ENDPOINTS -- STS endpoint mode some SSO/role setups require.
    //   LANG / LC_ALL -- locale, so the CLI's own output/encoding behaves normally.
    let mut cmd = Command::new(&bin);
    cmd.args(argv);
    cmd.env_clear();
    cmd.env("PATH", child_path);
    // HOME must always be present for config + SSO token cache resolution.
    if let Some(home) = std::env::var_os("HOME") {
        cmd.env("HOME", home);
    }
    // Pass through the remaining AWS/locale vars ONLY if the parent has them set.
    for key in [
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_PROFILE",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_CA_BUNDLE",
        "AWS_STS_REGIONAL_ENDPOINTS",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(val) = std::env::var_os(key) {
            cmd.env(key, val);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AwsError(
                    "The AWS CLI (`aws`) was not found. Looked in \
                     /usr/local/bin/aws, /opt/homebrew/bin/aws and /usr/bin/aws \
                     (a GUI app does not inherit your shell PATH). Install the \
                     AWS CLI, or set the AWS_CLI_PATH environment variable to its \
                     absolute path, then sign in (e.g. \
                     `aws sso login --profile <name>`) and retry."
                        .into(),
                )
            } else {
                AwsError(format!("Could not run the AWS CLI: {e}"))
            }
        })?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }

    // Surface stderr, but keep it to a friendly single message. SSO expiry is
    // the common case and gets a clearer hint. We truncate an over-long stderr
    // (LOW polish) so a wall of CLI output can't blow out the UI banner; this
    // is cosmetic only -- AWS CLI stderr carries no credentials, so nothing
    // sensitive is exposed either way.
    let stderr_raw = String::from_utf8_lossy(&output.stderr);
    let stderr = truncate_stderr(stderr_raw.trim());
    let msg = if stderr.contains("expired") || stderr.contains("SSO") || stderr.contains("sso") {
        format!(
            "AWS credentials look expired. Run `aws sso login --profile <name>` \
             and retry.\n\nCLI said: {stderr}"
        )
    } else {
        format!("The AWS CLI returned an error:\n{stderr}")
    };
    Err(AwsError(msg))
}

/// Cap CLI stderr surfaced to the UI at a reasonable length. Cosmetic only:
/// a huge stderr would otherwise fill the error banner. Truncates on a char
/// boundary (not a byte index, so multi-byte UTF-8 is never split) and appends
/// an ellipsis marker when clipped.
fn truncate_stderr(s: &str) -> String {
    const MAX: usize = 500;
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let clipped: String = s.chars().take(MAX).collect();
    format!("{clipped}\u{2026} [truncated]")
}

// ===========================================================================
// Tauri commands -- the ONLY AWS surface the frontend can reach.
// Each returns raw JSON text (String); the frontend JSON.parses it in a
// try/catch. All are read-only by construction (see the module docs).
// ===========================================================================

/// List the *names* of AWS CLI profiles from `~/.aws/config`.
///
/// SECURITY: this reads config only to extract `[profile NAME]` header names.
/// It never reads `~/.aws/credentials`, never parses key/secret/token lines,
/// and never returns any value other than profile names -- so no secret can
/// leave this function. Missing config is not an error: it returns an empty
/// list so the UI can show "no profiles found".
#[tauri::command]
pub fn list_profiles() -> Result<Vec<String>, AwsError> {
    let home = match std::env::var_os("HOME") {
        Some(h) => std::path::PathBuf::from(h),
        None => return Ok(Vec::new()),
    };
    let config = home.join(".aws").join("config");
    let text = match std::fs::read_to_string(&config) {
        Ok(t) => t,
        Err(_) => return Ok(Vec::new()), // no config -> no profiles, not an error
    };

    let mut names = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        // Section headers only. The AWS CLI writes non-default profiles as
        // `[profile NAME]` and the default as `[default]`.
        if !(line.starts_with('[') && line.ends_with(']')) {
            continue;
        }
        let inner = &line[1..line.len() - 1];
        let name = if inner == "default" {
            "default"
        } else if let Some(rest) = inner.strip_prefix("profile ") {
            rest.trim()
        } else {
            continue; // e.g. `[sso-session x]` -- not a runnable profile
        };
        // Only surface names we would actually accept as a --profile value.
        if !name.is_empty() && validate_profile(name).is_ok() && !names.contains(&name.to_string())
        {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

/// `aws networkmanager list-core-networks` -- returns raw JSON text.
#[tauri::command]
pub fn list_core_networks(profile: String, region: String) -> Result<String, AwsError> {
    let argv = build_argv(ReadOnlySubcommand::ListCoreNetworks, &profile, &region, &[])?;
    run_aws(&argv)
}

/// `aws networkmanager get-core-network-policy` for one core network -- returns
/// the deployed (LIVE_POLICY) policy document as raw JSON text. The frontend
/// digs out `.CoreNetworkPolicy.PolicyDocument` and feeds it to the existing
/// parser, so live and file-loaded policies render identically.
#[tauri::command]
pub fn get_live_policy(
    profile: String,
    region: String,
    core_network_id: String,
) -> Result<String, AwsError> {
    let id = validate_id(&core_network_id, "Core network id")?;
    let extra = vec!["--core-network-id".to_string(), id];
    let argv = build_argv(
        ReadOnlySubcommand::GetCoreNetworkPolicy,
        &profile,
        &region,
        &extra,
    )?;
    run_aws(&argv)
}

/// `aws networkmanager get-network-routes` for one segment edge -- returns the
/// live route table (propagated or static) as raw JSON text.
///
/// The real API requires `--global-network-id` AND a `--route-table-identifier`
/// that names a specific route table. A Cloud WAN *segment* route table is
/// per-segment-per-edge, so the identifier's `CoreNetworkSegmentEdge` must carry
/// `CoreNetworkId` + `SegmentName` + `EdgeLocation` -- a core-network id alone is
/// insufficient and the CLI rejects it. We therefore take all four inputs, each
/// validated, and build the identifier ourselves. `scope` is mapped through a
/// fixed allowlist to the API's `PROPAGATED`/`STATIC` enum.
///
/// The `--route-table-identifier` JSON is built with `serde_json` from ONLY
/// already-validated values (ids/segment/edge whose character sets exclude
/// quotes and braces). serde_json guarantees correct JSON escaping, so the
/// identifier cannot be broken or injected even if a validator were loosened;
/// it is still passed as a single argv item to the directly-spawned process,
/// never through a shell.
#[tauri::command]
pub fn get_live_routes(
    profile: String,
    region: String,
    global_network_id: String,
    core_network_id: String,
    segment_name: String,
    edge_location: String,
    scope: String,
) -> Result<String, AwsError> {
    let global_id = validate_id(&global_network_id, "Global network id")?;
    let core_id = validate_id(&core_network_id, "Core network id")?;
    let segment = validate_segment_name(&segment_name)?;
    let edge = validate_edge_location(&edge_location)?;
    let scope = validate_route_scope(&scope)?;

    // HARDENING (L2): build the --route-table-identifier JSON with serde_json
    // instead of interpolating a hand-written string. The upstream validators
    // above already reject quotes/braces/metacharacters, so this is defense in
    // depth (belt-and-suspenders): serde_json guarantees correct JSON escaping
    // even if a validator were ever loosened. serde_json is serde's
    // serialization companion, NOT a network client. The result is still passed
    // as ONE argv item to a directly-spawned process -- never through a shell.
    let identifier = serde_json::json!({
        "CoreNetworkSegmentEdge": {
            "CoreNetworkId": core_id,
            "SegmentName": segment,
            "EdgeLocation": edge,
        }
    })
    .to_string();
    let extra = vec![
        "--global-network-id".to_string(),
        global_id,
        "--route-table-identifier".to_string(),
        identifier,
        "--types".to_string(),
        scope.to_string(),
    ];
    let argv = build_argv(ReadOnlySubcommand::GetNetworkRoutes, &profile, &region, &extra)?;
    run_aws(&argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The argv builder is the security-critical seam, so it gets the most tests:
    // it must yield the exact read-only argv for good input and REJECT bad input
    // (malformed profile/region/id, and shell-injection attempts) before any
    // process is spawned.

    #[test]
    fn builds_expected_readonly_argv() {
        let argv = build_argv(
            ReadOnlySubcommand::ListCoreNetworks,
            "lab1c",
            "eu-west-1",
            &[],
        )
        .expect("valid input should build argv");
        assert_eq!(
            argv,
            vec![
                "networkmanager",
                "list-core-networks",
                "--profile",
                "lab1c",
                "--region",
                "eu-west-1",
                "--output",
                "json",
            ]
        );
    }

    #[test]
    fn every_allowlisted_subcommand_is_read_only() {
        // Guard against a future edit sneaking a mutating verb into the enum.
        let mutating = [
            "create", "update", "delete", "put", "modify", "associate", "register",
            "deregister", "start", "stop", "tag", "untag", "accept", "reject",
        ];
        for sub in [
            ReadOnlySubcommand::DescribeGlobalNetworks,
            ReadOnlySubcommand::ListCoreNetworks,
            ReadOnlySubcommand::GetCoreNetworkPolicy,
            ReadOnlySubcommand::GetNetworkRoutes,
            ReadOnlySubcommand::ListAttachments,
            ReadOnlySubcommand::GetVpcAttachment,
        ] {
            let verb = sub.as_str();
            let is_read_only =
                verb.starts_with("get-") || verb.starts_with("list-") || verb.starts_with("describe-");
            assert!(is_read_only, "{verb} must be get-/list-/describe-");
            for m in mutating {
                assert!(!verb.starts_with(m), "{verb} must not be a mutating verb");
            }
        }
    }

    #[test]
    fn rejects_injection_in_profile() {
        // A classic shell-injection attempt must be rejected at validation time.
        for bad in [
            "lab1c; rm -rf /",
            "lab1c && aws ec2 terminate-instances",
            "$(whoami)",
            "lab1c`id`",
            "lab 1c",
            "lab|c",
        ] {
            assert!(
                build_argv(ReadOnlySubcommand::ListCoreNetworks, bad, "eu-west-1", &[]).is_err(),
                "profile {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_bad_region() {
        for bad in ["EU-WEST-1", "eu west 1", "eu-west-1;", "us-east-1&&x", ""] {
            assert!(
                build_argv(ReadOnlySubcommand::GetNetworkRoutes, "lab1c", bad, &[]).is_err(),
                "region {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn accepts_valid_ids_rejects_bad_ids() {
        assert!(validate_id("core-network-0123456789abcdef0", "id").is_ok());
        assert!(validate_id("arn:aws:networkmanager::123:core-network/cn-1", "id").is_ok());
        for bad in ["cn-1; drop", "cn 1", "cn`id`", "cn$(x)", "cn|y", "\"cn\""] {
            assert!(validate_id(bad, "id").is_err(), "id {bad:?} should be rejected");
        }
    }

    #[test]
    fn route_scope_is_a_closed_allowlist() {
        // The frontend sends lowercase; we map to the API's PROPAGATED/STATIC enum.
        assert_eq!(validate_route_scope("propagated").unwrap(), "PROPAGATED");
        assert_eq!(validate_route_scope("static").unwrap(), "STATIC");
        assert!(validate_route_scope("delete").is_err());
        assert!(validate_route_scope("all; rm -rf /").is_err());
    }

    #[test]
    fn segment_and_edge_validation_reject_injection() {
        assert!(validate_segment_name("production").is_ok());
        assert!(validate_segment_name("shared01").is_ok());
        for bad in ["prod-seg", "seg name", "seg;rm", "seg$(x)", "", "seg/1"] {
            assert!(validate_segment_name(bad).is_err(), "segment {bad:?} should be rejected");
        }
        assert!(validate_edge_location("eu-west-1").is_ok());
        for bad in ["EU-WEST-1", "eu west 1", "eu;1", ""] {
            assert!(validate_edge_location(bad).is_err(), "edge {bad:?} should be rejected");
        }
    }

    #[test]
    fn get_live_routes_argv_carries_validated_id_and_scope() {        // Build the identifier exactly as the command does, proving the segment
        // edge is fully specified (CoreNetworkId + SegmentName + EdgeLocation),
        // the global-network-id is present, and every item stays a separate argv
        // token (no shell string).
        let core = validate_id("core-network-abc123", "Core network id").unwrap();
        let global = validate_id("global-network-def456", "Global network id").unwrap();
        let segment = validate_segment_name("production").unwrap();
        let edge = validate_edge_location("eu-west-1").unwrap();
        let identifier = serde_json::json!({
            "CoreNetworkSegmentEdge": {
                "CoreNetworkId": core,
                "SegmentName": segment,
                "EdgeLocation": edge,
            }
        })
        .to_string();
        let scope = validate_route_scope("propagated").unwrap();
        let extra = vec![
            "--global-network-id".to_string(),
            global.clone(),
            "--route-table-identifier".to_string(),
            identifier.clone(),
            "--types".to_string(),
            scope.to_string(),
        ];
        let argv =
            build_argv(ReadOnlySubcommand::GetNetworkRoutes, "lab1c", "eu-west-1", &extra).unwrap();
        assert_eq!(argv[0], "networkmanager");
        assert_eq!(argv[1], "get-network-routes");
        assert!(argv.contains(&"--global-network-id".to_string()));
        assert!(argv.contains(&global));
        assert!(argv.contains(&"--route-table-identifier".to_string()));
        assert!(argv.contains(&identifier));
        assert!(argv.contains(&"PROPAGATED".to_string()));
        // The identifier names all three required fields.
        assert!(identifier.contains("CoreNetworkId"));
        assert!(identifier.contains("SegmentName"));
        assert!(identifier.contains("EdgeLocation"));
    }

    #[test]
    fn identifier_fields_reject_double_quote_upstream() {
        // HARDENING (L2) guard: even though the identifier is now built with
        // serde_json (which would escape a quote correctly), the upstream
        // validators must STILL reject any value containing a double-quote --
        // defense in depth, so a quoted value never reaches JSON assembly at
        // all. This proves the validators were not removed by the refactor.
        assert!(
            validate_id("core-network-\"abc", "Core network id").is_err(),
            "a core-network id containing a double-quote must be rejected"
        );
        assert!(
            validate_id("global-\"net", "Global network id").is_err(),
            "a global-network id containing a double-quote must be rejected"
        );
        assert!(
            validate_segment_name("prod\"seg").is_err(),
            "a segment name containing a double-quote must be rejected"
        );
        assert!(
            validate_edge_location("eu-\"west-1").is_err(),
            "an edge location containing a double-quote must be rejected"
        );
    }

    // The binary resolver is the new seam that makes live mode work from a
    // Finder-launched .app (which does not inherit the shell PATH). It is pure
    // and injectable: we drive it with a predicate over a set of "existing"
    // paths, so these tests need no real `aws` binary or real filesystem layout.

    #[test]
    fn resolver_picks_first_existing_fixed_candidate() {
        let candidates = ["/usr/local/bin/aws", "/opt/homebrew/bin/aws", "/usr/bin/aws"];
        // Only the Apple-Silicon path "exists" here; the resolver must skip the
        // missing first candidate and pick it.
        let exists = |p: &str| p == "/opt/homebrew/bin/aws";
        assert_eq!(
            resolve_aws_bin(None, &candidates, exists).as_deref(),
            Some("/opt/homebrew/bin/aws")
        );

        // With the user's actual location present, that one wins (it is first).
        let exists_local = |p: &str| p == "/usr/local/bin/aws" || p == "/opt/homebrew/bin/aws";
        assert_eq!(
            resolve_aws_bin(None, &candidates, exists_local).as_deref(),
            Some("/usr/local/bin/aws")
        );
    }

    #[test]
    fn resolver_override_wins_when_usable() {
        let candidates = ["/usr/local/bin/aws"];
        // The override exists AND a fixed candidate exists -> override takes
        // precedence, letting a user point at a nonstandard install.
        let exists = |p: &str| p == "/opt/custom/aws" || p == "/usr/local/bin/aws";
        assert_eq!(
            resolve_aws_bin(Some("/opt/custom/aws"), &candidates, exists).as_deref(),
            Some("/opt/custom/aws")
        );
    }

    #[test]
    fn resolver_ignores_unusable_override_and_falls_through() {
        let candidates = ["/usr/local/bin/aws"];
        // Override is set but does NOT exist -> ignore it and use the fixed
        // candidate that does.
        let exists = |p: &str| p == "/usr/local/bin/aws";
        assert_eq!(
            resolve_aws_bin(Some("/does/not/exist/aws"), &candidates, exists).as_deref(),
            Some("/usr/local/bin/aws")
        );
        // An empty override string is treated as unset.
        assert_eq!(
            resolve_aws_bin(Some(""), &candidates, exists).as_deref(),
            Some("/usr/local/bin/aws")
        );
    }

    #[test]
    fn resolver_returns_none_when_nothing_resolves() {
        // No override, and no candidate exists -> None, so the caller falls back
        // to the bare-name PATH lookup (dev build in a terminal).
        let candidates = ["/usr/local/bin/aws", "/opt/homebrew/bin/aws", "/usr/bin/aws"];
        let exists = |_p: &str| false;
        assert_eq!(resolve_aws_bin(None, &candidates, exists), None);
    }

    #[test]
    fn users_actual_location_is_in_the_fixed_allowlist() {
        // Guard: the user's real install path must stay covered by the shipped
        // candidate list.
        assert!(AWS_BIN_CANDIDATES.contains(&"/usr/local/bin/aws"));
    }
}

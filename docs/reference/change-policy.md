# Change policy for the API, CLI and configuration

> **Proposed: not yet adopted.** This is a draft for the maintainer to approve or change. It exists to meet the last
> criterion for Stable in [Maturity and lifecycle](maturity-and-lifecycle.md) ("a stated change policy"). Every number
> and rule marked **Proposed** is a default I chose, not a decision. "Today" describes what the repository does now,
> from code and manifests.

## What the policy covers

| Surface                   | Where it is defined                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The HTTP API              | [`docs/api/openapi.yaml`](../api/openapi.yaml) (control plane), [`docs/api/harness-openapi.yaml`](../api/harness-openapi.yaml) (data plane) |
| The `mocactl` CLI         | [Command reference](cli-mocactl.md)                                                                                                         |
| Configuration             | [Configuration reference](configuration.md): environment variables, ConfigMaps, `setup.sh` flags                                            |
| The sandbox wire contract | `proto/sandbox/v1` (the `Attach` and `Exec` services)                                                                                       |
| Stored data               | Redis keys, the credential envelope, token claims, config bundles                                                                           |

It applies to **Stable** surfaces. A **Preview** surface may change at any time, but changes are listed in the release
notes. A **Legacy** surface does not change except for security and breakage fixes
([support policy](maturity-and-lifecycle.md#support-for-legacy-paths)).

## What is the contract today

- **HTTP routes.** The route table in `packages/knative-server/src/routes.ts` marks each route's `surface` as
  `client` or `internal`, and a contract test keeps the OpenAPI document and that table in step. Only `client` routes
  are described in the OpenAPI files. Both documents say `version: 1.0.0`, and the `/v1` prefix is the only version
  marker on the wire.
- **Aliases.** `/turn` and `/runs` are unprefixed aliases of `/v1/turn` and `/v1/runs` (internal, not marked
  deprecated). `/run-leaf` and `/run-leaf/status` are marked `deprecated` and log a warning once per process.
  `/runs/status` has no `/v1` form. `/workloads` is an operator surface, off unless enabled.
- **`mocactl`.** The version is injected at build time (a release tag, `edge-<sha>`, or `dev`). `--help` is global,
  exit codes are documented, and `--json` outputs are structured.
- **Configuration.** Variables keep historical prefixes (`SH_*`, `KAGENTI_*`, `MOCA_*`). Parsing is strict in some
  places and lenient in others ([Configuration](configuration.md#conventions)).
- **Wire contract.** `sandbox/v1` has been extended additively (for example the `workspace_key` field on `Exec`).
- **Stored data.** There is no schema-version key for Redis; new fields are handled by tolerant reads. The credential
  envelope is versioned (`v1.` prefix). Token claims are read by the data plane from the control plane's tokens.
- **Releases.** Tags are `v0.x.y`, so by semantic-versioning convention anything may change between minor releases.

## What counts as breaking

A change is **breaking** if a correct client or operator built against the previous behaviour can stop working:

- removing or renaming a route, field, query parameter, flag, environment variable or exit code;
- changing a field's type or meaning, a status code, or the meaning of an error code;
- narrowing the values a request accepts, or newly requiring a field, flag or variable;
- changing a default so that behaviour, capacity or security posture changes;
- changing a persisted format so the previous version cannot read data the new one wrote.

Not breaking: adding an optional field, route, flag, variable or error code. **Clients must therefore ignore unknown
response fields and tolerate unknown error codes.** Text output meant for people (log lines, `mocactl` prose, error
`message` strings) is not a contract; the structured fields are.

## The rules (Proposed)

1. **Within a release series** (`0.N.x` patch releases), Stable surfaces change only additively and with fixes. A
   breaking change waits for the next minor release.
2. **A breaking change to a Stable surface is deprecated first.** The deprecation is announced in the release notes
   and in the docs (a banner on the page), the surface keeps working for **at least one minor release** (Proposed),
   and only then may it be removed. The removal's release notes cite the deprecation.
3. **Deprecations are visible at runtime where possible.** Routes get `deprecated: true` in the route table and the
   OpenAPI file, and log a warning once per process (the mechanism `/run-leaf` already uses). Flags and variables get a
   one-line warning on use.
4. **Renames keep the old name working** for the deprecation period. Existing prefixes (`SH_*`, `KAGENTI_*`, `MOCA_*`)
   are not renamed in bulk; a rename is a breaking change like any other.
5. **A new required variable, or a changed default, is called out in the release notes under "Upgrade notes"**, with
   the order of upgrade when order matters (for example, the harness before the control plane for config bundles).
6. **A security fix may break a surface without notice**, and the release notes say so.

### By surface

| Surface            | Additive (allowed in a patch)                   | Breaking                                                                                                                  |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| HTTP API, `/v1`    | New optional fields, routes, error codes        | Removing or retyping anything; a new required field. Introduce `/v2` for a real break, or deprecate and remove per rule 2 |
| Unprefixed aliases | None: frozen. New features appear on `/v1` only | Removal needs the same notice as any route                                                                                |
| `mocactl`          | New commands, flags, `--json` fields            | Removing a flag or command, changing an exit code or a documented `--json` field                                          |
| Configuration      | New optional variables with a safe default      | Removing or renaming a variable; a new required one; a default that changes capacity or security                          |
| `sandbox/v1` wire  | New fields (additive, as `workspace_key` was)   | Anything else: introduce `sandbox/v2` and keep `v1` for the deprecation period                                            |
| Stored data        | New keys and new fields that older code ignores | A change older code cannot read. Needs a migration or a release that reads both formats                                   |

## Release notes (Proposed)

Every release states: breaking changes, deprecations and their removal release, new required configuration, upgrade
order requirements, and which paths are Preview, Stable or Legacy at that release. A release that names P6 as the
supported runtime also satisfies the first Stable criterion for the deployment paths it names.

## Decisions for the maintainer

These are the choices this draft makes for you. Change any of them:

1. **Is a minor release the right unit?** The project is `0.x`. The alternative is a time-based minimum (for example,
   three months) or "until the next Stable path release".
2. **Deprecation period: one minor release.** Longer for the HTTP API, shorter for the CLI?
3. **Do the unprefixed aliases `/turn` and `/runs` stay indefinitely, or get a removal date?** Today they are frozen
   and undeprecated.
4. **Is `GET /runs/status` getting a `/v1` form?** It is canonical without one.
5. **Is the `version: 1.0.0` in the OpenAPI files a real version?** If it is, say what bumps it.
6. **Stored-data compatibility:** is "readable by the previous release" the right bar, or do you want migrations?
7. **Config bundle format:** this draft says nothing about it, because no format version is documented. Decide whether
   it needs one.
8. **Who approves a breaking change?** Name an owner.

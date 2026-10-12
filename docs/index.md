# MOCA documentation

MOCA runs stateful AI coding-agent sessions as a backend service: sessions are durable and
resumable, the agent's reasoning (the _brain_) is isolated from the sandboxes that execute its
tools (the _hands_), many users share one deployment, and sandboxes are disposable. The README has
the pitch; this page is the map.

## Maturity labels

Every install path, guide and reference page should carry one of these. The label is a claim about
the path, not about the project as a whole.

| Label       | Meaning                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| **Stable**  | Supported, no planned removal.                                                                            |
| **Preview** | Implemented and the recommended direction, but not yet declared Stable. Interfaces and limits may change. |
| **Legacy**  | Deprecated. Security and breakage fixes only; removal is gated as described in the migration guide.       |

Today every deployment path is **Preview** except the Knative + KEDA path, which is **Legacy**
([ADR-0041](adrs/0041-deprecate-knative-keda-deployment.md)). What "Stable" requires for the
Preview paths is an open decision; see [`REORG-PLAN.md`](REORG-PLAN.md), open question 1.

## Start here

| I want to...                       | Go to                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Pick an install path and run MOCA  | [Get started](get-started/index.md)                                                                                                   |
| Leave the Knative/KEDA deployment  | [Migrating off the Knative/KEDA deployment](migrating-from-knative.md)                                                                |
| See the terms MOCA uses            | [Glossary](glossary.md)                                                                                                               |
| Call the HTTP API                  | [`api/openapi.yaml`](api/openapi.yaml), [`api/harness-openapi.yaml`](api/harness-openapi.yaml), [Context service](context-service.md) |
| Watch a guided walkthrough         | [Demos](demos/README.md)                                                                                                              |
| Understand why a decision was made | [ADRs](adrs/README.md) and the [spec registry](specs/README.md)                                                                       |
| Work on MOCA itself                | [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`CONTRIBUTING-DOCS.md`](CONTRIBUTING-DOCS.md)                                               |

## What is in `docs/`

| Location                                                      | What it is                                                             | Audience    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------- |
| `get-started/`                                                | Install-path chooser                                                   | New users   |
| `migrating-from-knative.md`                                   | The single deprecation and migration page                              | Operators   |
| `glossary.md`, `context-service.md`, `api/`                   | Terms and API reference                                                | Integrators |
| `demos/`                                                      | Guided, hand-driven walkthroughs                                       | Evaluators  |
| `specs/` (registry: `specs/README.md`)                        | Design specs; the milestone registry is the source of truth for status | Maintainers |
| `adrs/`                                                       | Immutable decision records                                             | Maintainers |
| `notes/`                                                      | Working notes, runbooks and result write-ups                           | Maintainers |
| `executive-overview-leaf-session.md`, `experiment-results.md` | Dated historical write-ups (Knative-era)                               | Background  |
| `REORG-PLAN.md`                                               | The plan this structure follows, with the audit and open questions     | Maintainers |

Install and operations guides live next to the scripts they describe: `deploy/compose/`,
`deploy/vm/`, `deploy/k8s/` and `deploy/microvm/`. Config and env-var reference, operations and
concept pages are planned but do not exist yet; see the new-docs backlog in
[`REORG-PLAN.md`](REORG-PLAN.md).

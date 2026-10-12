# Promoting a local Claude Code workflow

> **Preview.** Workflow promotion is implemented but not yet declared Stable; interfaces and limits
> may change. Design: [workflow promotion](../specs/2026-09-02-claude-code-workflow-promotion-design.md),
> [ADR-0030](../adrs/0030-claude-code-workflow-promotion.md).

Two ways to promote exist. `mocactl promote DIR` uploads through the multi-user control plane
([`packages/mocactl/README.md`](../../packages/mocactl/README.md),
[ADR-0038](../adrs/0038-mocactl-config-bundle-promotion.md)). This guide documents the older
harness-side path: the `/promote` slash command for Claude Code and the `pnpm promote` CLI, which
upload straight to a Redis. The bundle format, credential scan and dispatch field are the same.

Iterate on a workflow locally in Claude Code — skills, `CLAUDE.md`, memory, a slash command — then
promote it from inside Claude Code, in the project you want to promote:

```bash
mkdir -p ~/.claude/commands                                    # once
cp deploy/claude/commands/promote.md ~/.claude/commands/       # once
export SH_HARNESS_DIR=/path/to/moca              # once, per shell

# launch with the CLI granted at session level, so the grant outlives the command's own turn
claude --allowedTools "Bash(pnpm --dir $SH_HARNESS_DIR/harness promote:*)"

/promote my-workflow                                           # in any project, from Claude Code
```

The command's `allowed-tools` frontmatter grants the CLI for the turn the slash command creates. That
is enough when the promotion completes in that turn; if the turn ends first — an interruption, or a
guard that stops to ask — the grant is gone and the next turn's `pnpm` call is refused, since a
default install has no `pnpm` rule. The launch flag above avoids that, stays narrow (only the
`promote` script, only in that checkout), and needs no change to your settings. The equivalent
permanent form is the same rule in `permissions.allow`, with the path written out — a `*` inside the
pattern matches nothing.

`/promote` passes `--home` and `--project` for you, checks that the repo boundary and the Redis
tunnel are right before uploading, and reads the digest back through the cluster's own client
afterwards. It writes every path out in full, with no `$VAR` and no `HOME=… pnpm …` prefix, because
Claude Code will only match a command against `allowed-tools` if it can analyse it statically —
otherwise the command needs a permission prompt at best, and under `defaultMode: dontAsk` or `auto`
it is refused outright.

Installed in your **real** `~/.claude/commands/` as above, it is visible in every project and never
travels. You can instead keep it **in the project**, which lets you run Claude Code with
`HOME=<project>` so the local agent sees exactly what the promoted run will; `/promote` then detects
that it lives there and self-excludes with `--exclude-prompt promote` (see below), because otherwise
it would ship itself into every bundle.

Or drive the CLI directly:

```bash
cd harness && pnpm promote --entry my-workflow --project /path/to/your/project
```

`promote` reads the workflow — skills, `CLAUDE.md` chain, and memory — from `--project`, so
running it from the harness checkout without `--project` promotes the harness's own
configuration, not yours.

`--home <dir>` reads _user_ scope (skills, memory, prompts) from `<dir>/.claude` instead of your real
`$HOME`, and `--redis-url <url>` names the Redis to upload to. Both override the corresponding env
var (`HOME`, `REDIS_URL`) and produce a byte-identical bundle to it; they exist as flags so the whole
invocation can be one statically analyzable command, which is what `/promote` needs to run without a
permission prompt. The CLI prints the user scope it resolved, so you can see which one applied.

`promote` dedupes and classifies your local configuration, drops what cannot work in the harness
(with a reason for each), and scans for credentials before uploading. The scan has two tiers: a
structural match on a known key shape (an AWS access key, a PEM private-key block, a GitHub or
Slack token, an OpenAI-style key) **refuses the upload** and exits non-zero; a weaker prose
heuristic (`token: <value>`-shaped lines) only **warns and proceeds**, leaving the judgement to
you — that heuristic matches code and documentation placeholders too often to block on safely. It
writes a committable `.claude/promoted.lock.json` and uploads a content-addressed bundle; an
unchanged re-promotion uploads nothing.

Keep a prompt out of the bundle with `--exclude-prompt <name>`, repeatable. This exists for the
case where the command that _drives_ promotion lives in the project being promoted: with user scope
pointed at that project, its `.claude/commands/` is the prompts directory, so without the flag such
a command ships itself into every bundle. Excluding the entry prompt is refused outright, and an
exclusion that matches nothing warns — an unmatched exclusion would otherwise ship the prompt you
meant to omit.

Dispatch it by adding one field to any prompt leaf:

```json
{ "sessionId": "run-1/item-1", "kind": "prompt", "prompt": "…", "configRef": "sha256:…" }
```

Memory travels **read-only** — a promoted run consumes what you taught it locally and reports
discoveries back in the leaf result, which keeps leaf replay reproducible
([ADR-0031](../adrs/0031-promoted-memory-read-only.md)). MCP servers and subagents are not
promoted; see the [design](../specs/2026-09-02-claude-code-workflow-promotion-design.md) §2, §9.

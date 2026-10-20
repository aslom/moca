// ADR-0044 / spec 2026-10-20-audit-log-mirror-design.md: mirror audit decisions to stdout.
//
// Shape matches packages/supervisor/src/main.ts:49's opts.log so a future consolidation ADR can
// unify the two. Call sites construct the line object with keys from the identifier-only
// whitelist in the spec; the three enforcement tests in test/audit-log.test.ts catch drift.

export type AuditLog = (line: Record<string, unknown>) => void;

export const defaultAuditLog: AuditLog = (line) => console.log(JSON.stringify(line));

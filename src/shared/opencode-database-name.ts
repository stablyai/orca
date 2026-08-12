// Why: the opencode2 beta stores sessions in a channel-scoped SQLite DB
// (opencode-next.db on the default channel, opencode-local.db on the dev
// channel) while opencode v1 uses opencode.db plus stale sibling copies. Both
// match the `opencode*.db` glob used by Orca's v1 scanners, so callers must
// classify before parsing: the v2 schema (session_v2/session_message) is
// explicitly unstable in beta and must never reach the v1 parsers.
export const OPENCODE_V2_DATABASE_NAME_RE = /^opencode-(?:next|local)\.db$/i

export function isOpenCodeV2DatabaseName(name: string): boolean {
  return OPENCODE_V2_DATABASE_NAME_RE.test(name)
}

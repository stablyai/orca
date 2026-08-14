// Why: the opencode2 beta's channel-scoped DBs (opencode-next.db /
// opencode-local.db) match the v1 `opencode*.db` glob but carry the unstable
// v2 schema — callers must classify before parsing.
export const OPENCODE_V2_DATABASE_NAME_RE = /^opencode-(?:next|local)\.db$/i

export function isOpenCodeV2DatabaseName(name: string): boolean {
  return OPENCODE_V2_DATABASE_NAME_RE.test(name)
}

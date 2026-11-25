// Beta-only database names; current v2 releases share opencode.db with v1.
export const OPENCODE_V2_DATABASE_NAME_RE = /^opencode-(?:next|local)\.db$/i

export function isOpenCodeV2DatabaseName(name: string): boolean {
  return OPENCODE_V2_DATABASE_NAME_RE.test(name)
}

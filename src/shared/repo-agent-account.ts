/** Agents a project can pin to one of their saved accounts. */
export const REPO_AGENT_ACCOUNT_FIELDS = ['claudeAccountId', 'codexAccountId'] as const

export type RepoAgentAccountField = (typeof REPO_AGENT_ACCOUNT_FIELDS)[number]

/** Undefined leaves the pin, null clears it; an id names a folder, so anything malformed is
 *  dropped rather than saved. */
export function normalizeRepoAgentAccountId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return value
  }
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined
}

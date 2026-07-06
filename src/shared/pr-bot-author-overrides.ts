// Helpers for the `prBotAuthorOverrides` setting — comment author logins the
// user manually marked as bots. Shared so desktop renderer, main-process RPC,
// and mobile classify comment authors identically.

/** Normalized author login used to match manual bot overrides. */
export function normalizePRCommentAuthorLogin(author: string): string {
  return author.trim().toLowerCase()
}

/** Builds a lookup set from the persisted `prBotAuthorOverrides` setting. */
export function createBotAuthorOverrideSet(
  logins: Iterable<string> | null | undefined
): ReadonlySet<string> {
  const set = new Set<string>()
  for (const login of logins ?? []) {
    const normalized = normalizePRCommentAuthorLogin(login)
    if (normalized) {
      set.add(normalized)
    }
  }
  return set
}

// Cap the persisted list so a malformed settings payload can't bloat
// GlobalSettings or slow down per-comment override lookups.
export const MAX_PR_BOT_AUTHOR_OVERRIDES = 500

/** Sanitizes an untrusted settings update value into a sorted, deduped login list. */
export function normalizePRBotAuthorOverrides(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...createBotAuthorOverrideSet(value.filter((login) => typeof login === 'string'))]
    .sort()
    .slice(0, MAX_PR_BOT_AUTHOR_OVERRIDES)
}

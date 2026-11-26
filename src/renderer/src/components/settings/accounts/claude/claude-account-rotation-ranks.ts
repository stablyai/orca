/** Priority entries may name an account by its full id or by a prefix of it. */
function matchesAccount(entry: string, account: string): boolean {
  return account.startsWith(entry) || entry.startsWith(account)
}

/**
 * The accounts shown, in priority order, each once: an id and a prefix of it in the list are one
 * account, so they take one place.
 */
export function rankedAccounts(preferred: string[], shown: string[]): string[] {
  const ranked: string[] = []
  for (const entry of preferred) {
    const account = shown.find((name) => matchesAccount(entry, name))
    if (account !== undefined && !ranked.includes(account)) {
      ranked.push(account)
    }
  }
  return ranked
}

/** The priority list with `account` moved to `rank` (1-based), or taken out when null. */
export function withRank(
  preferred: string[],
  shown: string[],
  account: string,
  rank: number | null
): string[] {
  const visible = rankedAccounts(preferred, shown).filter((name) => name !== account)
  // Entries of accounts not on this Mac keep their place after the ones shown.
  const hidden = preferred.filter((entry) => !shown.some((name) => matchesAccount(entry, name)))
  if (rank !== null) {
    visible.splice(Math.min(rank - 1, visible.length), 0, account)
  }
  return [...visible, ...hidden]
}

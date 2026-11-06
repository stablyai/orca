// Share manual bot-login overrides across renderer, runtime RPC and mobile classification.

export const MAX_PR_BOT_AUTHOR_OVERRIDES = 500
// GitLab permits longer usernames than GitHub; 255 keeps both providers covered.
export const MAX_PR_COMMENT_AUTHOR_LOGIN_LENGTH = 255

export function normalizePRCommentAuthorLogin(author: string): string {
  if (author.length > MAX_PR_COMMENT_AUTHOR_LOGIN_LENGTH) {
    return ''
  }
  return author.trim().toLowerCase()
}

export function createBotAuthorOverrideSet(
  logins: Iterable<unknown> | null | undefined
): ReadonlySet<string> {
  const set = new Set<string>()
  const iterator = (logins ?? [])[Symbol.iterator]()
  let inspected = 0
  // Why: callers may pass untrusted settings; bound reads as well as retained output.
  while (inspected < MAX_PR_BOT_AUTHOR_OVERRIDES) {
    const next = iterator.next()
    if (next.done) {
      break
    }
    inspected += 1
    const login = next.value
    if (typeof login !== 'string') {
      continue
    }
    const normalized = normalizePRCommentAuthorLogin(login)
    if (normalized) {
      set.add(normalized)
    }
  }
  return set
}

export function normalizePRBotAuthorOverrides(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...createBotAuthorOverrideSet(value)].sort()
}

/** Atomically derives the next persisted list from the authoritative setting. */
export function applyPRBotAuthorOverride(
  current: Iterable<unknown> | null | undefined,
  author: string,
  isBot: boolean
): string[] {
  const overrides = new Set(createBotAuthorOverrideSet(current))
  const normalized = normalizePRCommentAuthorLogin(author)
  if (!normalized || overrides.has(normalized) === isBot) {
    return [...overrides].sort()
  }
  if (isBot) {
    if (overrides.size >= MAX_PR_BOT_AUTHOR_OVERRIDES) {
      return [...overrides].sort()
    }
    overrides.add(normalized)
  } else {
    overrides.delete(normalized)
  }
  return [...overrides].sort()
}

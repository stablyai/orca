/** Carries the sign-in link of an in-flight `codex login` from main to every window. */
export const CODEX_PENDING_LOGIN_URL_CHANGED_CHANNEL = 'codexAccounts:pendingLoginUrlChanged'

/** The rejection a cancelled `codex login` produces; the Accounts pane reads it to keep a cancellation out of the error toast. */
export const CODEX_LOGIN_CANCELLED_MESSAGE = 'Codex sign-in was cancelled.'

// Codex app-server sends this only for a login that is not ChatGPT (API key or Bedrock); missing auth reads differently.
const CODEX_API_KEY_RATE_LIMIT_ERROR_RE = /chatgpt authentication required to read rate limits/i

const CODEX_AUTH_ERROR_PATTERNS = [
  /access token could not be refreshed/i,
  /authentication session could not be refreshed/i,
  /refresh token (?:has expired|was already used|was revoked)/i,
  /you have since logged out or signed in to another account/i,
  /please (?:log out and )?sign in again/i,
  /please reauthenticate/i,
  /not logged in/i,
  /sign in with chatgpt/i,
  /token data is not available/i,
  /auth (?:is missing|tokens are missing|does not expose)/i,
  // The usage backend rejects a revoked or expired ChatGPT login with these codes; no retry recovers it.
  /\btoken_(?:revoked|expired|invalidated)\b/i,
  /invalidated oauth token/i,
  /backend-api\/wham\/usage failed: 401\b/i,
  // API-key-only homes lack ChatGPT tokens, so account/rateLimits/read cannot recover through a fallback read.
  /chatgpt authentication required/i
]
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g')

export function isCodexAuthError(error: string | null | undefined): boolean {
  const message = error?.trim()
  if (!message) {
    return false
  }
  return CODEX_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

/** A Codex usage failure that only signing in to the same account again can fix. */
export function isCodexUsageSignInRequired(limits: {
  provider: string
  error: string | null
  usageMetadata?: { failureKind?: string }
}): boolean {
  // A structured kind (network, a proven API-key home) outranks auth wording in the message.
  return (
    limits.provider === 'codex' &&
    !limits.usageMetadata?.failureKind &&
    isCodexAuthError(limits.error)
  )
}

export function isCodexApiKeyRateLimitError(error: string | null | undefined): boolean {
  return CODEX_API_KEY_RATE_LIMIT_ERROR_RE.test(error?.trim() ?? '')
}

export function extractCodexAuthError(output: string | null | undefined): string | null {
  if (!output) {
    return null
  }

  let cleanPrefix = ''
  for (const rawLine of iterateCodexOutputLines(output)) {
    const line = rawLine.replace(ANSI_ESCAPE_RE, '').trim()
    if (!line) {
      continue
    }
    if (isCodexAuthError(line)) {
      return line.slice(0, 4_000)
    }
    if (cleanPrefix.length < 4_000) {
      cleanPrefix = cleanPrefix ? `${cleanPrefix}\n${line}` : line
      cleanPrefix = cleanPrefix.slice(0, 4_000)
    }
  }

  return isCodexAuthError(cleanPrefix) ? cleanPrefix : null
}

function* iterateCodexOutputLines(output: string): Generator<string> {
  let lineStart = 0

  for (let index = 0; index < output.length; index++) {
    const code = output.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }

    yield output.slice(lineStart, index)
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index++
    }
    lineStart = index + 1
  }

  if (lineStart <= output.length) {
    yield output.slice(lineStart)
  }
}

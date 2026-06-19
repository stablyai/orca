const CODEX_AUTH_ERROR_PATTERNS = [
  /access token could not be refreshed/i,
  /authentication session could not be refreshed/i,
  /refresh token (?:has expired|was already used|was revoked)/i,
  /you have since logged out or signed in to another account/i,
  /please (?:log out and )?sign in again/i,
  /please reauthenticate/i,
  /not logged in/i,
  /token data is not available/i,
  /auth (?:is missing|tokens are missing|does not expose)/i
]
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g')

export function isCodexAuthError(error: string | null | undefined): boolean {
  const message = error?.trim()
  if (!message) {
    return false
  }
  return CODEX_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

export function extractCodexAuthError(output: string | null | undefined): string | null {
  const cleanOutput = output?.replace(ANSI_ESCAPE_RE, '').trim()
  if (!cleanOutput) {
    return null
  }

  const matchingLine = cleanOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(isCodexAuthError)
  if (matchingLine) {
    return matchingLine
  }

  return isCodexAuthError(cleanOutput) ? cleanOutput.slice(0, 4_000) : null
}

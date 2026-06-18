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

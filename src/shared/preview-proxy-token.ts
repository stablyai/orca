// Why: the preview token travels raw inside a Set-Cookie value and a URL query,
// and is compared against raw cookie bytes. A `;` would silently truncate the
// cookie (every request 401s with no clue), a control char makes writeHead
// throw on every token exchange — so main, CLI, and renderer all gate on the
// same cookie-safe alphabet.
export const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/

export function isValidPreviewToken(token: string): boolean {
  return PREVIEW_TOKEN_PATTERN.test(token)
}

export function resolvePreviewToken(
  flagToken: string | null,
  environmentToken: string | undefined
): string | null {
  return flagToken ?? (environmentToken?.trim() || null)
}

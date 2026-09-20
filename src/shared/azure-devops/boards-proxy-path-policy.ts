/**
 * Decides what a plugin may ask the host to fetch from Azure DevOps. The host
 * owns the origin and the credential; this module owns the path and method
 * scope. Pure and Electron-free so desktop and relay cannot drift.
 */

export const BOARDS_PROXY_METHODS = ['GET', 'POST', 'PATCH'] as const
export type BoardsProxyMethod = (typeof BOARDS_PROXY_METHODS)[number]

export type BoardsProxyRejection = {
  code: 'forbidden' | 'validation'
  message: string
}

// Optional leading segment is the Azure DevOps project. Nothing outside work
// items and projects is reachable — not Git, not builds, not release pipelines.
const ALLOWED_PATH = /^(?:\/[^/]+)?\/_apis\/(?:wit|projects)(?:\/|$)/

function isProxyMethod(value: string): value is BoardsProxyMethod {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: includes() does a runtime string-equality check against BOARDS_PROXY_METHODS; the cast only satisfies the parameter type and cannot widen which values match.
  return BOARDS_PROXY_METHODS.includes(value as BoardsProxyMethod)
}

export function checkBoardsProxyRequest(input: {
  method: string
  path: string
  query?: Record<string, string>
}): BoardsProxyRejection | null {
  if (!isProxyMethod(input.method)) {
    return { code: 'forbidden', message: `method ${input.method} is not permitted` }
  }

  const path = input.path
  if (!path.startsWith('/') || path.startsWith('//')) {
    return { code: 'validation', message: 'path must be origin-relative' }
  }
  // Decoded before matching so an encoded separator or dot segment cannot
  // smuggle a path the allowlist would otherwise reject.
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return { code: 'validation', message: 'path is not valid percent-encoding' }
  }
  if (decoded !== path) {
    return { code: 'validation', message: 'path must not be percent-encoded' }
  }
  if (path.includes('..') || path.includes('\\')) {
    return { code: 'validation', message: 'path must not contain traversal segments' }
  }
  if (path.includes(':')) {
    return { code: 'validation', message: 'path must not contain a scheme or authority' }
  }
  // Guard order is load-bearing: the tests pin each input to the guard that
  // rejects it, so reordering these checks changes which message a caller sees.
  if (!ALLOWED_PATH.test(path)) {
    return { code: 'forbidden', message: 'path is outside the Boards scope' }
  }

  for (const key of Object.keys(input.query ?? {})) {
    // Trimmed so a padded key (e.g. server-side name trimming) cannot slip past as a distinct parameter.
    if (key.trim().toLowerCase() === 'api-version') {
      return { code: 'validation', message: 'api-version is chosen by the host' }
    }
  }
  return null
}

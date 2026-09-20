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
const ALLOWED_PATH = /^(?:\/[^/]+)?\/_apis\/(wit|projects)(?:\/|$)/

// The consent string covers reading and updating work items only. POST
// /_apis/projects creates a project and PATCH /_apis/projects/{id} updates one,
// so the projects namespace is read-only however wide BOARDS_PROXY_METHODS is.
const NAMESPACE_METHODS = {
  projects: ['GET'],
  wit: ['GET', 'POST', 'PATCH']
} as const satisfies Record<string, readonly BoardsProxyMethod[]>

type BoardsNamespace = keyof typeof NAMESPACE_METHODS

function isProxyMethod(value: string): value is BoardsProxyMethod {
  return BOARDS_PROXY_METHODS.some((allowed) => allowed === value)
}

function boardsNamespace(path: string): BoardsNamespace | null {
  const name = ALLOWED_PATH.exec(path)?.[1]
  if (name === 'wit' || name === 'projects') {
    return name
  }
  return null
}

export function checkBoardsProxyRequest(input: {
  method: string
  path: string
  query?: Record<string, string>
}): BoardsProxyRejection | null {
  const method = input.method
  if (!isProxyMethod(method)) {
    return { code: 'forbidden', message: `method ${method} is not permitted` }
  }

  const path = input.path
  // First: the URL parser strips TAB, LF and CR before parsing, so a control
  // character splits a dot segment past every substring guard below.
  // oxlint-disable-next-line no-control-regex -- control characters ARE what this rejects
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return { code: 'validation', message: 'path must not contain control characters' }
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    return { code: 'validation', message: 'path must be origin-relative' }
  }
  // Any percent-encoding is refused: the decoded form is compared against the
  // raw path, never matched, so an encoded separator or dot segment cannot
  // reach the allowlist.
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
  // A query smuggled through the path bypasses the api-version guard below,
  // which only inspects input.query.
  if (path.includes('?') || path.includes('#')) {
    return { code: 'validation', message: 'path must not contain a query or fragment' }
  }
  // Guard order is load-bearing: the tests pin each input to the guard that
  // rejects it, so reordering these checks changes which message a caller sees.
  const namespace = boardsNamespace(path)
  if (namespace === null) {
    return { code: 'forbidden', message: 'path is outside the Boards scope' }
  }
  // The guards above see the raw string; the URL parser normalizes before the
  // request is made. Re-test the parsed pathname so the two can never disagree.
  const normalized = new URL(path, 'https://orca.invalid').pathname
  if (normalized !== path || boardsNamespace(normalized) === null) {
    return { code: 'forbidden', message: 'path is outside the Boards scope' }
  }
  if (!NAMESPACE_METHODS[namespace].some((allowed) => allowed === method)) {
    return {
      code: 'forbidden',
      message: `method ${method} is not permitted on _apis/${namespace}`
    }
  }

  for (const key of Object.keys(input.query ?? {})) {
    // Trimmed so a padded key (e.g. server-side name trimming) cannot slip past as a distinct parameter.
    if (key.trim().toLowerCase() === 'api-version') {
      return { code: 'validation', message: 'api-version is chosen by the host' }
    }
  }
  return null
}

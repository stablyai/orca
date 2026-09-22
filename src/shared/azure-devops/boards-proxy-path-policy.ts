/**
 * Decides what a plugin may ask the host to fetch from Azure DevOps. The host
 * owns the origin and the credential; this module owns the path and method
 * scope. Pure and Electron-free so desktop and relay cannot drift.
 */

export const BOARDS_PROXY_METHODS = ['GET', 'POST', 'PATCH'] as const

/** The only media type a caller may ask for. Everything else is plain JSON. */
export const BOARDS_PROXY_JSON_PATCH_CONTENT_TYPE = 'application/json-patch+json'

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

// A namespace-wide write rule is too wide: _apis/wit also carries
// classificationnodes (area and iteration structure) and queries (stored
// queries), both of which Azure documents as mutating POST endpoints. Consent
// to "Azure DevOps Boards" does not imply reshaping a project's Boards
// metadata, so writes are matched by route. Reads stay namespace-wide.
const WIT_WRITE_ROUTES: readonly { method: BoardsProxyMethod; route: RegExp }[] = [
  // WIQL is a read expressed as a POST.
  { method: 'POST', route: /^\/_apis\/wit\/wiql$/i },
  // Create a work item of a named type: /_apis/wit/workitems/$User%20Story.
  { method: 'POST', route: /^\/_apis\/wit\/workitems\/\$[^/]+$/i },
  // Comment on a work item.
  { method: 'POST', route: /^\/_apis\/wit\/workitems\/\d+\/comments$/i },
  // Update a work item's fields.
  { method: 'PATCH', route: /^\/_apis\/wit\/workitems\/\d+$/i }
]

/** Drops the optional leading project segment so a route matches either form. */
function apiSuffix(path: string): string {
  const index = path.indexOf('/_apis/')
  return index === -1 ? path : path.slice(index)
}

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

// Run against the raw path AND its decoded form, so an encoded spelling of any
// of these cannot pass a guard that only reads the raw string.
function checkPathShape(candidate: string): BoardsProxyRejection | null {
  // The URL parser strips TAB, LF and CR before parsing, so a control character
  // splits a dot segment past the substring guards below.
  // oxlint-disable-next-line no-control-regex -- control characters ARE what this rejects
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    return { code: 'validation', message: 'path must not contain control characters' }
  }
  if (candidate.includes('..') || candidate.includes('\\')) {
    return { code: 'validation', message: 'path must not contain traversal segments' }
  }
  if (candidate.includes(':')) {
    return { code: 'validation', message: 'path must not contain a scheme or authority' }
  }
  return null
}

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

export function checkBoardsProxyRequest(input: {
  method: string
  path: string
  query?: Record<string, string>
  body?: unknown
}): BoardsProxyRejection | null {
  const method = input.method
  if (!isProxyMethod(method)) {
    return { code: 'forbidden', message: `method ${method} is not permitted` }
  }
  // fetch() rejects synchronously when a GET carries a body, which would
  // otherwise surface as an opaque 503 further down the pipeline.
  if (method === 'GET' && input.body !== undefined) {
    return { code: 'validation', message: 'GET requests must not carry a body' }
  }

  const path = input.path
  if (!path.startsWith('/') || path.startsWith('//')) {
    return { code: 'validation', message: 'path must be origin-relative' }
  }
  // Guard order is load-bearing: the tests pin each input to the guard that
  // rejects it, so reordering these checks changes which message a caller sees.
  const rawShape = checkPathShape(path)
  if (rawShape !== null) {
    return rawShape
  }
  // A query smuggled through the path carries parameters this module never
  // reviews ($top, $expand). api-version is not among them: apiUrl() re-sets it
  // after parsing, so a path-borne one is overwritten rather than honoured.
  if (path.includes('?') || path.includes('#')) {
    return { code: 'validation', message: 'path must not contain a query or fragment' }
  }
  // Percent-encoding is allowed because work item type names are addressed by
  // name and have no GUID form: "User Story" is only reachable as User%20Story.
  // Encoded separators and dot segments are caught by re-running the shape
  // guards on the decoded form and by the parsed-pathname equality below.
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return { code: 'validation', message: 'path is not valid percent-encoding' }
  }
  // A surviving '%' means the caller encoded an encoding: %252e%252e decodes to
  // %2e%2e, which the guards below would then read as harmless literal text.
  if (decoded.includes('%')) {
    return { code: 'validation', message: 'path must not be double percent-encoded' }
  }
  const decodedShape = checkPathShape(decoded)
  if (decodedShape !== null) {
    return decodedShape
  }
  const namespace = boardsNamespace(path)
  // The decoded form is matched too: an encoded slash would otherwise widen the
  // single project segment into a path of its own (/a%2Fb/_apis/wit/...).
  if (namespace === null || boardsNamespace(decoded) === null) {
    return { code: 'forbidden', message: 'path is outside the Boards scope' }
  }
  // $batch takes a list of {method, uri, body} sub-requests in its body, none of
  // which reach this module. Checked on every decoded segment, not just the
  // last, so /_apis/wit/$batch/x cannot smuggle it past the guard. Checked on
  // the decoded form so %24batch cannot spell it. Plain '$' stays legal:
  // /_apis/wit/workitems/$Bug creates a work item.
  if (segments(decoded).some((segment) => segment.toLowerCase() === '$batch')) {
    return {
      code: 'forbidden',
      message: 'batch requests are not permitted because their sub-request URIs are not reviewable'
    }
  }
  // The guards above see the raw string; the URL parser normalizes before the
  // request is made. Re-test the parsed pathname so the two can never disagree:
  // '/./' collapses, and a raw space or non-ASCII byte gets escaped. It is also
  // a second net under every encoded dot segment, which collapses here too.
  const normalized = new URL(path, 'https://orca.invalid').pathname
  if (normalized !== path) {
    return { code: 'forbidden', message: 'path is outside the Boards scope' }
  }
  if (!NAMESPACE_METHODS[namespace].some((allowed) => allowed === method)) {
    return {
      code: 'forbidden',
      message: `method ${method} is not permitted on _apis/${namespace}`
    }
  }
  if (method !== 'GET') {
    const suffix = apiSuffix(path)
    const permitted = WIT_WRITE_ROUTES.some(
      (allowed) => allowed.method === method && allowed.route.test(suffix)
    )
    if (!permitted) {
      return {
        code: 'forbidden',
        message: `method ${method} is not permitted on this _apis/${namespace} route`
      }
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

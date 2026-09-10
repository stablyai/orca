// Pure parsing for linking an Odoo ticket (a `project.task`) to a worktree.
// Kept dependency-free so the worktree meta builder and its unit tests resolve
// ticket ids / instance origins without touching the store or Electron APIs.

export type OdooTicketLinkParse = {
  /** Positive `project.task` id, or null when the input carries no ticket id. */
  id: number | null
  /** Normalized lowercase origin when the input was a URL; null otherwise. */
  origin: string | null
}

const RAW_INT_RE = /^\d+$/
// `.../odoo/project/<pid>/task/<id>` — the Odoo 17 project kanban task route.
const PROJECT_TASK_PATH_RE = /\/odoo\/project\/\d+\/task\/(\d+)/
// `.../odoo/action-project.<name>/<id>` — task opened straight from a project
// action. Other action namespaces address other models, so accepting them would
// mislink a workspace to an unrelated record id.
const ACTION_PATH_RE = /\/odoo\/action-project[^/]*\/(\d+)/
// Generic trailing `/task/<id>` fallback for other task-shaped routes.
const GENERIC_TASK_PATH_RE = /\/task\/(\d+)(?:[/?#]|$)/

function toPositiveInt(value: string | null | undefined): number | null {
  if (!value || !RAW_INT_RE.test(value)) {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function firstPathId(path: string, ...patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = path.match(pattern)
    if (match) {
      return toPositiveInt(match[1])
    }
  }
  return null
}

// The legacy web client encodes the record in the URL fragment, e.g.
// `/web#id=4&model=project.task&view_type=form`. Only accept it when the model
// is a project.task so pasting some other record cannot mislink a ticket.
function idFromWebHash(url: URL): number | null {
  const rawHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  if (!rawHash) {
    return null
  }
  const params = new URLSearchParams(rawHash)
  return params.get('model') === 'project.task' ? toPositiveInt(params.get('id')) : null
}

function idFromOdooUrl(url: URL): number | null {
  const pathId = firstPathId(url.pathname, PROJECT_TASK_PATH_RE, ACTION_PATH_RE)
  if (pathId !== null) {
    return pathId
  }
  const hashId = idFromWebHash(url)
  if (hashId !== null) {
    return hashId
  }
  return firstPathId(url.pathname, GENERIC_TASK_PATH_RE)
}

/** Lowercased origin (scheme + host + port) for instance matching, or null. */
export function normalizeOdooOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Parse a raw ticket id or an Odoo task URL into an id + (URL) origin. Returns
 * `{ id: null }` for empty or unparseable input so callers can distinguish
 * "clear the link" (empty) from "leave untouched" (unparseable non-empty).
 */
export function parseOdooTicketLink(input: string): OdooTicketLinkParse {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { id: null, origin: null }
  }
  if (RAW_INT_RE.test(trimmed)) {
    return { id: toPositiveInt(trimmed), origin: null }
  }
  let url: URL | null = null
  try {
    url = new URL(trimmed)
  } catch {
    url = null
  }
  if (url) {
    const id = idFromOdooUrl(url)
    // A non-special scheme (`mycompany:8069/...`) parses but has the literal
    // string `'null'` as its origin; the contract here is a real origin or null.
    const origin = url.origin === 'null' ? null : url.origin.toLowerCase()
    return { id, origin: id !== null ? origin : null }
  }
  // Protocol-less paste: still recover a ticket id, but there is no origin to
  // match, so instance resolution falls back to the selected instance.
  const id = firstPathId(trimmed, PROJECT_TASK_PATH_RE, ACTION_PATH_RE, GENERIC_TASK_PATH_RE)
  return { id, origin: null }
}

/**
 * Resolve the connected Odoo instance whose server origin matches a linked
 * URL's origin. Returns null when the origin is absent or unmatched, so the
 * caller can fall back to the selected/active instance.
 */
export function matchOdooInstanceIdByOrigin(
  origin: string | null,
  instances: readonly { id: string; serverUrl: string }[]
): string | null {
  if (!origin) {
    return null
  }
  const match = instances.find((instance) => normalizeOdooOrigin(instance.serverUrl) === origin)
  return match ? match.id : null
}

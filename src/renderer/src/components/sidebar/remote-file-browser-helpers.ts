export type DirEntry = {
  name: string
  isDirectory: boolean
}

export function filterEntries(entries: DirEntry[], filter: string): DirEntry[] {
  const q = filter.trim().toLowerCase()
  if (!q) {
    return entries
  }
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

// Enter-key behavior for the filter input:
//   (a) filtered set has exactly one folder → navigate into it
//       (files alongside it don't block — a folder match wins)
//   (b) filtered set has exactly one file and no folders → fileHint
//   (c) otherwise → noop
export type EnterAction =
  | { type: 'navigate'; name: string }
  | { type: 'fileHint' }
  | { type: 'noop' }

export function decideEnterAction(filteredEntries: DirEntry[]): EnterAction {
  const folders = filteredEntries.filter((e) => e.isDirectory)
  if (folders.length === 1) {
    return { type: 'navigate', name: folders[0].name }
  }
  if (folders.length === 0 && filteredEntries.length > 0) {
    return { type: 'fileHint' }
  }
  return { type: 'noop' }
}

export type EscAction = { type: 'clearFilter' } | { type: 'cancel' }

export function decideEscAction(filter: string): EscAction {
  return filter.length > 0 ? { type: 'clearFilter' } : { type: 'cancel' }
}

export function joinPath(resolvedPath: string, name: string): string {
  return resolvedPath === '/' ? `/${name}` : `${resolvedPath}/${name}`
}

export function parentPath(p: string): string {
  if (p === '/' || p === '') {
    return '/'
  }
  const parent = p.replace(/\/[^/]+\/?$/, '')
  return parent || '/'
}

// ---------- Path-aware filter parsing ----------

export type ParsedInput =
  | { mode: 'filter'; filter: string }
  | {
      mode: 'path'
      // `root` = absolute `/`, `home` = resolved SSH user home, `cwd` = the
      // currently committed resolvedPath.
      base: 'root' | 'home' | 'cwd'
      // Segments to resolve one-by-one from the base. Empty string segments
      // never appear here — repeated separators are surfaced via `invalid`.
      committedSegments: string[]
      // The part after the final separator. Drives the local filter applied
      // to the resolved preview directory; empty when input ends with `/`.
      trailingFilter: string
      // Only set for repeated-separator inputs; other resolution failures are
      // reported at resolve time so error messages can name the failing seg.
      invalid?: string
    }

// Path mode triggers when the input contains `/` or is one of the three
// base-marker literals (`~`, `.`, `..`). The literal `..` rule is required
// because "contains /" alone would keep bare `..` in filter mode.
export function isPathMode(raw: string): boolean {
  if (raw.includes('/')) {
    return true
  }
  return raw === '~' || raw === '.' || raw === '..'
}

export function parsePathInput(raw: string): ParsedInput {
  if (!isPathMode(raw)) {
    // Filter mode preserves the raw text; trimming happens inside
    // `filterEntries` so leading/trailing spaces don't alter the input shown
    // back to the user.
    return { mode: 'filter', filter: raw }
  }

  // Base-marker literals with no trailing slash.
  if (raw === '~') {
    return { mode: 'path', base: 'home', committedSegments: [], trailingFilter: '' }
  }
  if (raw === '.') {
    return { mode: 'path', base: 'cwd', committedSegments: [], trailingFilter: '' }
  }
  if (raw === '..') {
    return { mode: 'path', base: 'cwd', committedSegments: ['..'], trailingFilter: '' }
  }

  let base: 'root' | 'home' | 'cwd'
  let remainder: string
  if (raw.startsWith('/')) {
    base = 'root'
    remainder = raw.slice(1)
  } else if (raw.startsWith('~/')) {
    base = 'home'
    remainder = raw.slice(2)
  } else {
    base = 'cwd'
    remainder = raw
  }

  // Don't collapse `//`: the visible input must agree with the path being
  // resolved. Report it as invalid and let the caller surface the error.
  if (remainder.includes('//')) {
    return {
      mode: 'path',
      base,
      committedSegments: [],
      trailingFilter: '',
      invalid: 'Invalid path: repeated separators'
    }
  }

  // Reject control characters (including NUL and newlines) in path input.
  // These segments are eventually shell-escaped and passed to `cd <path> && ls`;
  // embedded newlines would corrupt the line-based `ls -1` parser, and NUL
  // bytes cause undefined behavior in the shell / C string boundaries. Single-
  // quote shell-escaping protects against injection but not against these
  // structural hazards, so we reject at the parse layer.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(remainder)) {
    return {
      mode: 'path',
      base,
      committedSegments: [],
      trailingFilter: '',
      invalid: 'Invalid path: control characters are not allowed'
    }
  }

  // `split('/')` leaves an empty string when `remainder` ends with `/`, which
  // is the only legal "empty tail" and simply means "no trailing filter".
  const parts = remainder === '' ? [''] : remainder.split('/')
  const trailingFilter = parts.at(-1) ?? ''
  const committedSegments = parts.slice(0, -1)

  return { mode: 'path', base, committedSegments, trailingFilter }
}

export type SegmentOutcome =
  | { type: 'stay' }
  | { type: 'descend'; name: string }
  | { type: 'error'; message: string }

// Pure decision step for one committed segment. The caller supplies the
// base path (for error messages) and that base's listing.
export function resolveSegmentStep(
  segment: string,
  basePath: string,
  baseEntries: DirEntry[]
): SegmentOutcome {
  if (segment === '.') {
    return { type: 'stay' }
  }
  if (segment === '..') {
    return { type: 'stay' } // caller turns this into parent navigation
  }
  // Exact (case-sensitive) match wins. When both `Documents` and `documents`
  // exist on a case-sensitive POSIX filesystem, the user's literal spelling
  // must be authoritative.
  const exact = baseEntries.find((e) => e.name === segment)
  if (exact) {
    if (exact.isDirectory) {
      return { type: 'descend', name: exact.name }
    }
    // Stop resolution: prefix-matching to a similarly-named folder here would
    // silently bypass a real file the user pointed at.
    return { type: 'error', message: `${segment} isn't a directory in ${basePath}` }
  }
  // Fall back to case-insensitive matching so segment resolution agrees with
  // the case-insensitive filter input. Without this, typing `documents/`
  // errors while typing `documents` finds `Documents` via the filter — the
  // two modes must not disagree. Remote listings can still be case-sensitive;
  // we only accept CI matches when the case-sensitive match is absent.
  const segLower = segment.toLowerCase()
  const ciExact = baseEntries.find((e) => e.name.toLowerCase() === segLower)
  if (ciExact) {
    if (ciExact.isDirectory) {
      return { type: 'descend', name: ciExact.name }
    }
    return { type: 'error', message: `${segment} isn't a directory in ${basePath}` }
  }
  const dirMatches = baseEntries.filter(
    (e) => e.isDirectory && e.name.toLowerCase().startsWith(segLower)
  )
  if (dirMatches.length === 1) {
    return { type: 'descend', name: dirMatches[0].name }
  }
  if (dirMatches.length > 1) {
    return { type: 'error', message: `${segment} matches multiple directories in ${basePath}` }
  }
  return { type: 'error', message: `${segment} isn't a directory in ${basePath}` }
}

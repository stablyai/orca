import { parseFileLinkLocation, type ParsedFileLinkLocation } from './file-link-location'

// Shape-only detection for the Cmd+P palette: which queries should be treated as
// an explicit path to open rather than only a fuzzy file-name search.

const EXPLICIT_PATH_PREFIX_REGEX = /^(?:~[\\/]|[\\/]|\.\.?[\\/]|[A-Za-z]:[\\/])/
const ABSOLUTE_OR_TILDE_SHAPE_REGEX = /^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/])/

/** True when a palette query looks like an explicit path: rooted/tilde/relative/drive/UNC, or any token containing a separator. Bare names (`auth.ts`) stay fuzzy-only. */
export function isLikelyExplicitPathQuery(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return false
  }
  return EXPLICIT_PATH_PREFIX_REGEX.test(trimmed) || trimmed.includes('/') || trimmed.includes('\\')
}

/**
 * Split a path-like palette query into path text plus an optional `:line[:column]`
 * suffix, reusing the terminal-link location parser. No existence or host-home
 * resolution happens here; the renderer resolves `pathText` against the worktree
 * (and `~`) the same way terminal file links do.
 */
export function normalizeLiteralPathQuery(query: string): ParsedFileLinkLocation | null {
  if (!isLikelyExplicitPathQuery(query)) {
    return null
  }
  const parsed = parseFileLinkLocation(query.trim())
  if (!parsed) {
    return null
  }
  const { pathText } = parsed
  // Parity with terminal links: a separator immediately followed by whitespace is prose, not a path,
  // and a trailing separator only disambiguates an absolute/tilde shape, never a relative one.
  if (
    /^[\\/]\s/.test(pathText) ||
    (/[\\/]$/.test(pathText) && !ABSOLUTE_OR_TILDE_SHAPE_REGEX.test(pathText))
  ) {
    return null
  }
  return parsed
}

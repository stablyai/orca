// Pure classifier for markdown link targets. Called by the link-activation
// dispatcher (activateMarkdownLink slice action) from three call sites —
// MarkdownPreview, RichMarkdownEditor Cmd-click, RichMarkdownLinkBubble open —
// so behavior stays consistent across preview/rich/bubble entry points.
//
// See docs/markdown-internal-link-opening-design.md for the full rationale.

export type MarkdownLinkTarget =
  | { kind: 'anchor' }
  | { kind: 'external'; url: string }
  | {
      kind: 'markdown'
      absolutePath: string
      relativePath: string
      line?: number
      column?: number
    }
  | {
      kind: 'file'
      uri: string
      absolutePath: string
      relativePath?: string
      line?: number
      column?: number
    }

// Why: renderer runs with sandbox + contextIsolation, so process.platform is
// unavailable. navigator.userAgent is the portable fallback (AGENTS.md).
const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
const isMacLike = ua.includes('Mac')
const isWindowsLike = ua.includes('Windows')
const caseInsensitiveFs = isMacLike || isWindowsLike

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown'])

export function absolutePathToFileUri(filePath: string): string {
  return toFileUrl(filePath)
}

function toFileUrl(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/')
  const segments = normalizedPath.split('/').map((segment, index) => {
    if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
      return segment
    }
    return encodeURIComponent(segment)
  })
  if (normalizedPath.startsWith('/')) {
    return `file://${segments.join('/')}`
  }
  return `file:///${segments.join('/')}`
}

function fileUrlToAbsolutePath(url: URL): string {
  let absolutePath = decodeURIComponent(url.pathname)
  // Windows: "/C:/foo" → "C:/foo"
  if (/^\/[A-Za-z]:\//.test(absolutePath)) {
    absolutePath = absolutePath.slice(1)
  }
  return absolutePath
}

function normalizePathForCompare(p: string): string {
  let np = p.replaceAll('\\', '/')
  while (np.endsWith('/') && np.length > 1) {
    np = np.slice(0, -1)
  }
  return np
}

function isDescendantOf(childAbs: string, parentAbs: string): boolean {
  const child = normalizePathForCompare(childAbs)
  const parent = normalizePathForCompare(parentAbs)
  if (caseInsensitiveFs) {
    const lc = child.toLowerCase()
    const lp = parent.toLowerCase()
    return lc === lp || lc.startsWith(`${lp}/`)
  }
  return child === parent || child.startsWith(`${parent}/`)
}

function hasMarkdownExtension(p: string): boolean {
  const lastDot = p.lastIndexOf('.')
  if (lastDot === -1) {
    return false
  }
  return MARKDOWN_EXTENSIONS.has(p.slice(lastDot).toLowerCase())
}

// Extract `:line` or `:line:col` from the end of a path. Must anchor to
// end-of-string and require digits so legal filenames containing `:` are not
// silently truncated.
function extractTrailingLineCol(path: string): { path: string; line?: number; column?: number } {
  const match = /:(\d+)(?::(\d+))?$/.exec(path)
  if (!match) {
    return { path }
  }
  return {
    path: path.slice(0, match.index),
    line: Number(match[1]),
    column: match[2] ? Number(match[2]) : undefined
  }
}

// Parse `#L10` / `#L10C5` anchor (case-insensitive). Non-matching fragments
// (e.g., `#heading`) return undefined so they flow through as normal links.
function extractHashLineCol(hash: string): { line?: number; column?: number } {
  if (!hash) {
    return {}
  }
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  const match = /^L(\d+)(?:C(\d+))?$/i.exec(trimmed)
  if (!match) {
    return {}
  }
  return {
    line: Number(match[1]),
    column: match[2] ? Number(match[2]) : undefined
  }
}

function resolveRelativeToSource(rawHref: string, sourceFilePath: string): URL | null {
  try {
    return new URL(rawHref, toFileUrl(sourceFilePath))
  } catch {
    return null
  }
}

function computeRelativePath(absolutePath: string, worktreeRoot: string): string {
  const parent = normalizePathForCompare(worktreeRoot)
  const child = normalizePathForCompare(absolutePath)
  const prefix = `${parent}/`
  if (caseInsensitiveFs) {
    if (child.toLowerCase() === parent.toLowerCase()) {
      return ''
    }
    if (child.toLowerCase().startsWith(prefix.toLowerCase())) {
      return child.slice(prefix.length)
    }
  } else {
    if (child === parent) {
      return ''
    }
    if (child.startsWith(prefix)) {
      return child.slice(prefix.length)
    }
  }
  return child
}

export function resolveMarkdownLinkTarget(
  rawHref: string | undefined,
  sourceFilePath: string,
  worktreeRoot: string | null
): MarkdownLinkTarget | null {
  if (rawHref === undefined || rawHref === '') {
    return null
  }
  if (rawHref.startsWith('#')) {
    return { kind: 'anchor' }
  }

  const resolved = resolveRelativeToSource(rawHref, sourceFilePath)
  if (!resolved) {
    return null
  }

  if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
    return { kind: 'external', url: resolved.toString() }
  }

  if (resolved.protocol !== 'file:') {
    return null
  }

  const rawAbsolutePath = fileUrlToAbsolutePath(resolved)

  // Why: hash-based line anchor takes precedence; fall back to trailing
  // `:line:col` syntax only if no hash anchor was found.
  const hashParsed = extractHashLineCol(resolved.hash)
  let line = hashParsed.line
  let column = hashParsed.column

  let pathForClassification = rawAbsolutePath
  if (line === undefined) {
    const trailing = extractTrailingLineCol(rawAbsolutePath)
    if (trailing.line !== undefined) {
      pathForClassification = trailing.path
      line = trailing.line
      column = trailing.column
    }
  }

  if (
    worktreeRoot !== null &&
    hasMarkdownExtension(pathForClassification) &&
    isDescendantOf(pathForClassification, worktreeRoot)
  ) {
    const relativePath = computeRelativePath(pathForClassification, worktreeRoot)
    return {
      kind: 'markdown',
      absolutePath: pathForClassification,
      relativePath,
      line,
      column
    }
  }

  const relativePath =
    worktreeRoot !== null && isDescendantOf(pathForClassification, worktreeRoot)
      ? computeRelativePath(pathForClassification, worktreeRoot)
      : undefined

  // Rebuild a file: URI without the line anchor so the OS handler gets a
  // clean path. Use the original resolved URL minus the hash as an
  // approximation; for trailing-colon paths there's no clean URL form,
  // so we reconstruct from the stripped absolute path.
  const cleanUri = line === undefined ? resolved.toString() : toFileUrl(pathForClassification)
  return {
    kind: 'file',
    uri: cleanUri,
    absolutePath: pathForClassification,
    relativePath,
    line,
    column
  }
}

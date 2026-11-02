import {
  filesystemPathHrefToFileUri,
  filesystemPathToFileUri,
  fileUriToFilesystemPath
} from '../../../../shared/file-uri-path'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'

// Share classification across preview, rich-editor and link-bubble activation; see docs/markdown-internal-link-opening-design.md.

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

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown'])

export function absolutePathToFileUri(filePath: string): string {
  return toFileUrl(filePath)
}

function toFileUrl(filePath: string): string {
  return filesystemPathToFileUri(filePath)
}

function fileUrlToAbsolutePath(url: URL): string | null {
  return fileUriToFilesystemPath(url)
}

function normalizePathForCompare(p: string): string {
  let np = p.replaceAll('\\', '/')
  while (np.endsWith('/') && np.length > 1) {
    np = np.slice(0, -1)
  }
  return np
}

export function hasMarkdownExtension(p: string): boolean {
  const lastDot = p.lastIndexOf('.')
  if (lastDot === -1) {
    return false
  }
  return MARKDOWN_EXTENSIONS.has(p.slice(lastDot).toLowerCase())
}

// Require trailing numeric line/column syntax so filenames containing colons are not truncated.
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

// Leave non-line fragments such as heading anchors available to normal link handling.
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
    if (isWindowsAbsolutePathLike(rawHref)) {
      // Convert Windows drive paths to file URLs before URL mistakes the drive letter for a scheme.
      return new URL(filesystemPathHrefToFileUri(rawHref))
    }
    return new URL(rawHref, toFileUrl(sourceFilePath))
  } catch {
    return null
  }
}

function computeRelativePath(absolutePath: string, worktreeRoot: string): string {
  return relativePathInsideRoot(worktreeRoot, absolutePath) ?? normalizePathForCompare(absolutePath)
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
  if (rawAbsolutePath === null) {
    return null
  }

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
    relativePathInsideRoot(worktreeRoot, pathForClassification) !== null
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
    worktreeRoot !== null && relativePathInsideRoot(worktreeRoot, pathForClassification) !== null
      ? computeRelativePath(pathForClassification, worktreeRoot)
      : undefined

  // Strip line anchors before OS handoff; trailing-colon syntax requires rebuilding the file URL from its stripped path.
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

const HTML_ATTRIBUTE_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g

export function projectMarkdownHrefForClipboard(href: string): string | null {
  const projected = href.replace(HTML_ATTRIBUTE_WHITESPACE, '')
  if (!projected || containsAsciiControl(projected)) {
    return null
  }
  if (
    isWindowsAbsolutePathLike(projected) ||
    projected.startsWith('\\\\') ||
    projected.startsWith('//')
  ) {
    return null
  }
  if (projected.startsWith('#')) {
    return projected
  }

  const scheme = /^([A-Za-z][A-Za-z\d+.-]*):/.exec(projected)?.[1]?.toLowerCase()
  if (!scheme) {
    return projected
  }
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'file') {
    return null
  }
  try {
    const parsed = new URL(projected)
    if (parsed.protocol !== `${scheme}:`) {
      return null
    }
    if (scheme === 'file' && !parsed.pathname) {
      return null
    }
    return projected
  } catch {
    return null
  }
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) {
      return true
    }
  }
  return false
}

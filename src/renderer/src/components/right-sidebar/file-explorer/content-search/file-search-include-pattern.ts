import { normalizeRelativePath } from '@/lib/path'

const SEARCH_GLOB_LITERAL_META = new Set(['\\', '*', '?', '[', ']', '{', '}', '!', ','])

function escapeSearchGlobLiteralSegment(segment: string): string {
  let escaped = ''
  for (const ch of segment) {
    escaped += SEARCH_GLOB_LITERAL_META.has(ch) ? `\\${ch}` : ch
  }
  return escaped
}

/** Append /** because bare folder globs are literal paths in ripgrep/git grep and do not recurse. */
export function folderRelativePathToIncludeGlob(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath).replace(/\/+$/, '')
  if (!normalized) {
    return ''
  }
  const escaped = normalized.split('/').map(escapeSearchGlobLiteralSegment).join('/')
  return `${escaped}/**`
}

export function selectedExplorerFolderRelativePath(activeElement: Element | null): string | null {
  const explorerShell = activeElement?.closest('[data-orca-explorer-shell]')
  return explorerShell?.getAttribute('data-selected-folder-relative-path') ?? null
}

export type FileExplorerMoveConfirmMode = 'never' | 'directories' | 'always'

export function shouldConfirmFileExplorerMove(
  mode: FileExplorerMoveConfirmMode | undefined | null,
  isDirectory: boolean
): boolean {
  if (mode === 'always') {
    return true
  }
  if (mode === 'directories') {
    return isDirectory
  }
  return false
}

/** Relative path for dialog copy; falls back to basename-style absolute when outside root. */
export function formatFileExplorerMovePath(path: string, worktreePath: string | null): string {
  if (!worktreePath) {
    return path
  }
  const normalizedRoot = worktreePath.replace(/[/\\]+$/, '')
  const rootWithSep = `${normalizedRoot}/`
  const rootWithWinSep = `${normalizedRoot}\\`
  if (path === normalizedRoot) {
    return '.'
  }
  if (path.startsWith(rootWithSep)) {
    return path.slice(rootWithSep.length)
  }
  if (path.startsWith(rootWithWinSep)) {
    return path.slice(rootWithWinSep.length)
  }
  return path
}

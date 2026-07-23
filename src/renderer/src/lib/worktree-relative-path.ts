import { isPathInsideWorktree, toWorktreeRelativePath } from './terminal-links'

export function toWorktreeRelativePathOrAbsolute(
  filePath: string,
  worktreePath: string | null | undefined
): string {
  if (!worktreePath || !isPathInsideWorktree(filePath, worktreePath)) {
    return filePath
  }
  const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
  if (maybeRelative !== null && maybeRelative.length > 0) {
    return maybeRelative
  }
  return filePath
}

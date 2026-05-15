import { WORKTREE_ID_SEPARATOR } from './pty-session-id-format'

export { WORKTREE_ID_SEPARATOR } from './pty-session-id-format'

export type ParsedWorktreeId = {
  repoId: string
  worktreePath: string
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  return separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
}

export function splitWorktreeId(worktreeId: string): ParsedWorktreeId | null {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  if (separatorIdx === -1) {
    return null
  }
  return {
    repoId: worktreeId.slice(0, separatorIdx),
    worktreePath: worktreeId.slice(separatorIdx + WORKTREE_ID_SEPARATOR.length)
  }
}

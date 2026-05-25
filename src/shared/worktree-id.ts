import { WORKTREE_ID_SEPARATOR } from './pty-session-id-format'

export { WORKTREE_ID_SEPARATOR } from './pty-session-id-format'

export type ParsedWorktreeId = {
  repoId: string
  worktreePath: string
}

export const WORKSPACE_INSTANCE_SEPARATOR = '::workspace:'
export const FOLDER_WORKSPACE_INSTANCE_SEPARATOR = WORKSPACE_INSTANCE_SEPARATOR
const WORKSPACE_INSTANCE_SUFFIX = new RegExp(
  `${WORKSPACE_INSTANCE_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f-]{36}$`
)

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

export function splitWorktreeIdForFilesystem(worktreeId: string): ParsedWorktreeId | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    return null
  }
  return {
    repoId: parsed.repoId,
    // Why: multiple workspace sessions can be backed by the same folder or
    // Git checkout. Their IDs carry a UUID suffix, but filesystem callers
    // still need the real path as cwd/root.
    worktreePath: stripWorkspaceInstanceSuffix(parsed.worktreePath)
  }
}

export function stripWorkspaceInstanceSuffix(value: string): string {
  return value.replace(WORKSPACE_INSTANCE_SUFFIX, '')
}

export function getWorktreePathBasenameFromId(worktreeId: string): string | null {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const normalizedPath = parsed?.worktreePath.trim().replace(/[\\/]+$/g, '') ?? ''
  if (!normalizedPath) {
    return null
  }
  const basename = normalizedPath.split(/[\\/]/).filter(Boolean).at(-1)?.trim()
  return basename || null
}

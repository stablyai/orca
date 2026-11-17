import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'

export type NativeChatWorkingLocation =
  | {
      kind: 'worktree'
      worktreeId: string
      repoId: string
      hostId: ExecutionHostId | undefined
      path: string
      displayName: string
      branch: string | null
      /** A discovered worktree the sidebar hides until it is imported. */
      hidden: boolean
    }
  | { kind: 'folder'; path: string; displayName: string }

type WorktreeRow = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'path' | 'displayName' | 'branch'>

function sameHost(a: ExecutionHostId | undefined, b: ExecutionHostId | undefined): boolean {
  return a === undefined || b === undefined || a === b
}

function shortBranch(branch: string | null | undefined): string | null {
  return branch ? branch.replace(/^refs\/heads\//, '') : null
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path
}

function located(row: WorktreeRow, hidden: boolean): NativeChatWorkingLocation {
  return {
    kind: 'worktree',
    worktreeId: row.id,
    repoId: row.repoId,
    hostId: row.hostId,
    path: row.path,
    displayName: row.displayName || lastSegment(row.path),
    branch: shortBranch(row.branch),
    hidden
  }
}

/** Where a chat's agent works, when that is not the chat's own workspace; null otherwise. */
export function resolveNativeChatWorkingLocation(args: {
  workingDirectory: string | undefined
  chatWorktree: Pick<Worktree, 'path' | 'hostId'> | undefined
  worktrees: Readonly<Record<string, readonly WorktreeRow[]>>
  /** Discovered listings; their `visible: false` rows are the sidebar's hidden worktrees. */
  detectedWorktrees: Readonly<
    Record<string, { worktrees: readonly (WorktreeRow & { visible: boolean })[] } | undefined>
  >
}): NativeChatWorkingLocation | null {
  const { workingDirectory, chatWorktree } = args
  if (!workingDirectory) {
    return null
  }
  const target = normalizeRuntimePathForComparison(workingDirectory)
  if (chatWorktree && normalizeRuntimePathForComparison(chatWorktree.path) === target) {
    return null
  }
  const hostId = chatWorktree?.hostId
  const matches = (row: WorktreeRow): boolean =>
    sameHost(row.hostId, hostId) && normalizeRuntimePathForComparison(row.path) === target
  for (const rows of Object.values(args.worktrees)) {
    const row = rows.find(matches)
    if (row) {
      return located(row, false)
    }
  }
  for (const detected of Object.values(args.detectedWorktrees)) {
    const row = detected?.worktrees.find((worktree) => !worktree.visible && matches(worktree))
    if (row) {
      return located(row, true)
    }
  }
  return { kind: 'folder', path: workingDirectory, displayName: lastSegment(workingDirectory) }
}

import type { DiffComment } from '../../../../../shared/diff-comment-types'
import { authorityKey, type HostAuthority } from '../../../../../shared/host-authority'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { AppState } from '../../types'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { resolveRecordOwner, resolveSourceCopy } from '@/lib/workspace-copy-owner'
import { findIndexedWorktreeRows } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { selectWorktreesByRepo } from '../../workspaces/catalog/workspace-record-fields'

const EMPTY_DIFF_COMMENTS = Object.freeze([]) as unknown as DiffComment[]
export { EMPTY_DIFF_COMMENTS }

/** Every store field note ownership is resolved from; a write changing none of them changes no owner. */
export const DIFF_COMMENT_OWNER_INPUTS = [
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'repos',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'settings',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
] as const satisfies readonly (keyof AppState)[]

export type DiffCommentSelectorState = Pick<AppState, 'worktreesByRepo'> &
  Partial<Pick<AppState, (typeof DIFF_COMMENT_OWNER_INPUTS)[number]>>

/** The listed rows of one copy (each resolved by the shared record rule); duplicates share notes, the last winning as in the id index. */
export function findCopyRows(
  state: DiffCommentSelectorState,
  worktreeId: string,
  authority: HostAuthority
): Worktree[] {
  const key = authorityKey(authority)
  const rows = findIndexedWorktreeRows(
    selectWorktreesByRepo(state),
    getRepoIdFromWorktreeId(worktreeId),
    worktreeId
  )
  return rows.filter((row) => {
    const own = resolveRecordOwner(state, row)
    return own.kind === 'resolved' && authorityKey(own.owner) === key
  })
}

/** Notes of the copy's rows; undefined while it is not listed. */
export function readCopyNotes(rows: readonly Worktree[]): DiffComment[] | undefined {
  return rows.length > 0 ? (rows.at(-1)?.diffComments ?? EMPTY_DIFF_COMMENTS) : undefined
}

export function selectWorktreeDiffComments(
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined
): DiffComment[] | undefined {
  if (!worktreeId) {
    return undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return findFolderWorkspaceOwner(state, scope.folderWorkspaceId)?.diffComments
  }
  // Only an identifiable copy shows notes; another copy's notes would invite writes to it.
  const copy = resolveSourceCopy(state, worktreeId, 'selection')
  return copy.kind === 'resolved'
    ? readCopyNotes(findCopyRows(state, worktreeId, copy.owner))
    : undefined
}

export function selectWorktreeDiffCommentsOrEmpty(
  state: Parameters<typeof selectWorktreeDiffComments>[0],
  worktreeId: string | null | undefined
): DiffComment[] {
  return selectWorktreeDiffComments(state, worktreeId) ?? EMPTY_DIFF_COMMENTS
}

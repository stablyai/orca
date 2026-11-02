import type { DiffComment } from '../../../shared/diff-comment-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { authorityKey, type HostAuthority } from '../../../shared/host-authority'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  DIFF_COMMENT_OWNER_INPUTS,
  EMPTY_DIFF_COMMENTS,
  findCopyRows,
  readCopyNotes,
  resolveDiffCommentCopy,
  type DiffCommentSelectorState,
  type DiffCommentSource
} from './worktree-diff-comments-selector'

/** A copy whose notes can be changed: the workspace and the authority serving it (endpoint plus place). */
export type DiffCommentOwner =
  | { kind: 'worktree'; worktreeId: string; authority: HostAuthority }
  | {
      kind: 'folder'
      worktreeId: string
      executionHostId: ExecutionHostId
      runtimeEnvironmentId: string | null
    }

/**
 * Owner and notes from one read, so actions change exactly the copy whose notes are shown.
 * `comments` is undefined while that copy is unknown or not listed yet; that is not an empty list.
 */
export type DiffCommentView = {
  owner: DiffCommentOwner | null
  comments: DiffComment[] | undefined
}

const NO_DIFF_COMMENT_VIEW: DiffCommentView = Object.freeze({ owner: null, comments: undefined })

export function selectDiffCommentView(
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined,
  source?: DiffCommentSource
): DiffCommentView {
  if (!worktreeId) {
    return NO_DIFF_COMMENT_VIEW
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = findFolderWorkspaceOwner(state, scope.folderWorkspaceId)
    if (!folder) {
      return NO_DIFF_COMMENT_VIEW
    }
    const executionHostId = getExecutionHostIdForFolderWorkspace(state, scope.folderWorkspaceId)
    return {
      owner: {
        kind: 'folder',
        worktreeId,
        executionHostId,
        runtimeEnvironmentId: getRuntimeEnvironmentIdForFolderWorkspace(
          state,
          scope.folderWorkspaceId,
          executionHostId
        )
      },
      comments: folder.diffComments ?? EMPTY_DIFF_COMMENTS
    }
  }
  const copy = resolveDiffCommentCopy(state, worktreeId, source)
  // Distinct copies with nothing naming one stay unknown rather than showing an arbitrary copy.
  if (!copy || copy === 'ambiguous') {
    return NO_DIFF_COMMENT_VIEW
  }
  return {
    owner: { kind: 'worktree', worktreeId, authority: copy },
    comments: readCopyNotes(findCopyRows(state, worktreeId, copy))
  }
}

/** Same copy, same key: stamps confirming an authority don't change it; rival servers and hosts differ. */
export function diffCommentOwnerKey(owner: DiffCommentOwner): string {
  return JSON.stringify(
    owner.kind === 'folder'
      ? [owner.worktreeId, owner.executionHostId, owner.runtimeEnvironmentId]
      : [owner.worktreeId, authorityKey(owner.authority)]
  )
}

/** The captured copy's notes, or undefined when it is not listed (gone, or not yet arrived). */
export function readOwnedDiffComments(
  state: DiffCommentSelectorState,
  owner: DiffCommentOwner
): DiffComment[] | undefined {
  if (owner.kind === 'folder') {
    const scope = parseWorkspaceKey(owner.worktreeId)
    const folder =
      scope?.type === 'folder'
        ? findFolderWorkspaceOwner(state, scope.folderWorkspaceId, owner.executionHostId)
        : null
    return folder ? (folder.diffComments ?? EMPTY_DIFF_COMMENTS) : undefined
  }
  return readCopyNotes(findCopyRows(state, owner.worktreeId, owner.authority))
}

/**
 * A per-consumer cached read: a store write that changes no ownership input, with the same
 * arguments, returns the previous result without row work; an equal result keeps its identity.
 */
function cacheOnOwnerInputs<Args extends readonly unknown[], Result>(
  read: (state: DiffCommentSelectorState, ...args: Args) => Result,
  equal: (previous: Result, next: Result) => boolean
): (state: DiffCommentSelectorState, ...args: Args) => Result {
  let inputs: unknown[] | null = null
  let result: { value: Result } | null = null
  return (state, ...args) => {
    const next = [...args, ...DIFF_COMMENT_OWNER_INPUTS.map((key) => state[key])]
    if (result && inputs?.every((input, index) => Object.is(input, next[index]))) {
      return result.value
    }
    inputs = next
    const value = read(state, ...args)
    if (!result || !equal(result.value, value)) {
      result = { value }
    }
    return result.value
  }
}

export function createDiffCommentViewSelector(): (
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined,
  runtimeEnvironmentId?: string | null
) => DiffCommentView {
  return cacheOnOwnerInputs(
    (state, worktreeId: string | null | undefined, runtimeEnvironmentId?: string | null) =>
      selectDiffCommentView(state, worktreeId, { runtimeEnvironmentId }),
    (previous, next) =>
      previous.comments === next.comments &&
      JSON.stringify(previous.owner) === JSON.stringify(next.owner)
  )
}

/** A captured action's notes, read through the same cache as views (open Clear confirmations). */
export function createOwnedDiffCommentsSelector(): (
  state: DiffCommentSelectorState,
  owner: DiffCommentOwner | null
) => DiffComment[] | undefined {
  return cacheOnOwnerInputs(
    (state, owner: DiffCommentOwner | null) =>
      owner ? readOwnedDiffComments(state, owner) : undefined,
    Object.is
  )
}

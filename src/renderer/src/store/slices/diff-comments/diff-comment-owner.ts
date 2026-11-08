import type { DiffComment } from '../../../../../shared/diff-comment-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { authorityKey, type HostAuthority } from '../../../../../shared/host-authority'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  DIFF_COMMENT_OWNER_INPUTS,
  EMPTY_DIFF_COMMENTS,
  findCopyRows,
  readCopyNotes,
  type DiffCommentSelectorState
} from './worktree-diff-comments-selector'
import { focusFreeRouteStateOf } from '@/lib/editor-file-operation-provenance'
import {
  resolveSourceCopy,
  resolveSourceFolderHost,
  type WorkspaceCopySource,
  type WorkspaceResource
} from '@/lib/workspace-copy-owner'

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

/** The folder copy a source names: its catalog record and the endpoint serving that catalog, together. */
function selectFolderView(
  state: DiffCommentSelectorState,
  worktreeId: string,
  folderWorkspaceId: string,
  source: WorkspaceCopySource
): DiffCommentView {
  const qualifier = resolveSourceFolderHost(state, worktreeId, folderWorkspaceId, source)
  if (qualifier.kind !== 'resolved') {
    return NO_DIFF_COMMENT_VIEW
  }
  const hostId = qualifier.owner
  // Without its own host, a retained resource may not fall back to the selected folder.
  const ownerState = source === 'selection' ? state : focusFreeRouteStateOf(state)
  const folder = findFolderWorkspaceOwner(ownerState, folderWorkspaceId, hostId)
  if (!folder) {
    return NO_DIFF_COMMENT_VIEW
  }
  const executionHostId = getExecutionHostIdForFolderWorkspace(
    ownerState,
    folderWorkspaceId,
    hostId
  )
  return {
    owner: {
      kind: 'folder',
      worktreeId,
      executionHostId,
      runtimeEnvironmentId: getRuntimeEnvironmentIdForFolderWorkspace(
        ownerState,
        folderWorkspaceId,
        executionHostId
      )
    },
    comments: folder.diffComments ?? EMPTY_DIFF_COMMENTS
  }
}

/** Owner and notes of the copy a source shows; resource-bound surfaces pass their own resource. */
export function selectDiffCommentView(
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined,
  source: WorkspaceCopySource
): DiffCommentView {
  if (!worktreeId) {
    return NO_DIFF_COMMENT_VIEW
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return selectFolderView(state, worktreeId, scope.folderWorkspaceId, source)
  }
  const copy = resolveSourceCopy(state, worktreeId, source)
  // Rival copies with nothing naming one stay unknown rather than showing an arbitrary copy.
  if (copy.kind !== 'resolved') {
    return NO_DIFF_COMMENT_VIEW
  }
  return {
    owner: { kind: 'worktree', worktreeId, authority: copy.owner },
    comments: readCopyNotes(findCopyRows(state, worktreeId, copy.owner))
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

/** A captured folder copy's catalog record, only while the captured endpoint still serves it: reads, mutations, the queue and rollback all use this one lookup. */
export function findOwnedFolder(
  state: DiffCommentSelectorState,
  owner: Extract<DiffCommentOwner, { kind: 'folder' }>
): ReturnType<typeof findFolderWorkspaceOwner> {
  const scope = parseWorkspaceKey(owner.worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  const folder = findFolderWorkspaceOwner(state, scope.folderWorkspaceId, owner.executionHostId)
  return folder &&
    getRuntimeEnvironmentIdForFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      owner.executionHostId
    ) === owner.runtimeEnvironmentId
    ? folder
    : null
}

/** The captured copy's notes, or undefined when it is not listed (gone, or not yet arrived). */
export function readOwnedDiffComments(
  state: DiffCommentSelectorState,
  owner: DiffCommentOwner
): DiffComment[] | undefined {
  if (owner.kind === 'folder') {
    const folder = findOwnedFolder(state, owner)
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

/** Cache arguments: the source's own fields, so a fresh wrapper object for the same tab still hits. */
type SourceParts = [
  selection: boolean,
  runtimeEnvironmentId: WorkspaceResource['runtimeEnvironmentId'],
  externalSshTargetId: WorkspaceResource['externalSshTargetId'],
  operationProvenance: WorkspaceResource['operationProvenance']
]

export function sourceParts(source: WorkspaceCopySource): SourceParts {
  return source === 'selection'
    ? [true, undefined, undefined, undefined]
    : [false, source.runtimeEnvironmentId, source.externalSshTargetId, source.operationProvenance]
}

export function createDiffCommentViewSelector(): (
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined,
  ...source: SourceParts
) => DiffCommentView {
  return cacheOnOwnerInputs(
    (
      state,
      worktreeId: string | null | undefined,
      ...[selection, runtimeEnvironmentId, externalSshTargetId, operationProvenance]: SourceParts
    ) =>
      selectDiffCommentView(
        state,
        worktreeId,
        selection ? 'selection' : { runtimeEnvironmentId, externalSshTargetId, operationProvenance }
      ),
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

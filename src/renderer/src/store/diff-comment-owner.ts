import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/qualified-worktree-execution-owner'
import type { DiffComment } from '../../../shared/diff-comment-types'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { namedHostForOwnerRef, runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectWorktreesByRepo } from './workspace-record-selectors'
import {
  DIFF_COMMENT_OWNER_INPUTS,
  diffCommentRowNotes,
  findDiffCommentRows,
  type DiffCommentSelectorState,
  type DiffCommentTwin
} from './worktree-diff-comments-selector'

/** A copy whose notes can be changed: its rows (`hostId`/`runtimeOwnerEnvironmentId`) and the transport its writes take. */
export type ResolvedDiffCommentOwner =
  | ({
      kind: 'worktree'
      worktreeId: string
      writeHostId?: ExecutionHostId
      target: RuntimeClientTarget | null
    } & DiffCommentTwin)
  | {
      kind: 'folder'
      worktreeId: string
      executionHostId: ExecutionHostId
      runtimeEnvironmentId: string | null
    }

/** A workspace not listed yet when the user acted: the host selected for it then, resolved when the change is made. */
export type UnlistedDiffCommentOwner = {
  kind: 'unlisted'
  worktreeId: string
  hostId: ExecutionHostId | null
}

export type DiffCommentOwner = ResolvedDiffCommentOwner | UnlistedDiffCommentOwner

/** Owner and notes from one read, so actions change exactly the copy whose notes are shown. */
export type DiffCommentView = {
  owner: DiffCommentOwner | null
  comments: DiffComment[] | undefined
}

const NO_DIFF_COMMENT_VIEW: DiffCommentView = Object.freeze({ owner: null, comments: undefined })

function targetHostId(target: RuntimeClientTarget | null): ExecutionHostId | undefined {
  return target?.kind === 'local'
    ? 'local'
    : target?.kind === 'environment'
      ? toRuntimeExecutionHostId(target.environmentId)
      : undefined
}

export function selectDiffCommentView(
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined
): DiffCommentView {
  if (!worktreeId) {
    return NO_DIFF_COMMENT_VIEW
  }
  const named = namedHostForOwnerRef(state, { workspaceId: worktreeId })
  const unlisted: DiffCommentView = {
    owner: { kind: 'unlisted', worktreeId, hostId: named },
    comments: undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = findFolderWorkspaceOwner(state, scope.folderWorkspaceId)
    if (!folder) {
      return unlisted
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
      comments: folder.diffComments
    }
  }
  // The same rows selectWorktreeDiffComments shows.
  const found = findDiffCommentRows(state, worktreeId)
  if (!found?.twin) {
    return unlisted
  }
  const writeHostId =
    found.hostId ??
    named ??
    resolveQualifiedWorktreeExecutionOwner(selectWorktreesByRepo(state), state.repos, worktreeId)
      ?.hostId ??
    targetHostId(runtimeTargetForWorkspaceOwner(state, { workspaceId: worktreeId }))
  return {
    owner: {
      kind: 'worktree',
      worktreeId,
      ...found.twin,
      ...(writeHostId ? { writeHostId } : {}),
      // Main's write-time resolver, run now: it recovers a paired server proxying an SSH row the row itself doesn't name.
      target: runtimeTargetForWorkspaceOwner(state, {
        workspaceId: worktreeId,
        hostId: writeHostId
      })
    },
    comments: diffCommentRowNotes(found)
  }
}

/**
 * A per-consumer view selector: a store write that changes no ownership input returns the previous
 * view without resolving, and an equal result keeps the previous identity, so consumers don't re-render.
 */
export function createDiffCommentViewSelector(): (
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined
) => DiffCommentView {
  let inputs: unknown[] | null = null
  let view = NO_DIFF_COMMENT_VIEW
  let ownerJson = 'null'
  return (state, worktreeId) => {
    if (
      inputs?.[0] === worktreeId &&
      DIFF_COMMENT_OWNER_INPUTS.every((key, index) => Object.is(state[key], inputs?.[index + 1]))
    ) {
      return view
    }
    inputs = [worktreeId, ...DIFF_COMMENT_OWNER_INPUTS.map((key) => state[key])]
    const next = selectDiffCommentView(state, worktreeId)
    const nextJson = JSON.stringify(next.owner)
    if (nextJson !== ownerJson || next.comments !== view.comments) {
      view = next
      ownerJson = nextJson
    }
    return view
  }
}

/** Same copy, same key: a listing that later stamps the copy's host or server doesn't change it; twins differ by machine or transport. */
export function diffCommentOwnerKey(owner: DiffCommentOwner): string {
  switch (owner.kind) {
    case 'folder':
      return JSON.stringify([owner.worktreeId, owner.executionHostId, owner.runtimeEnvironmentId])
    case 'unlisted':
      return JSON.stringify([owner.worktreeId, owner.hostId])
    case 'worktree':
      return JSON.stringify([
        owner.worktreeId,
        owner.hostId ?? owner.writeHostId ?? null,
        targetHostId(owner.target) ?? null
      ])
  }
}

function readResolvedDiffComments(
  state: DiffCommentSelectorState,
  owner: ResolvedDiffCommentOwner
): { list: DiffComment[] | undefined } | null {
  if (owner.kind === 'folder') {
    const scope = parseWorkspaceKey(owner.worktreeId)
    const folder =
      scope?.type === 'folder'
        ? findFolderWorkspaceOwner(state, scope.folderWorkspaceId, owner.executionHostId)
        : null
    return folder ? { list: folder.diffComments } : null
  }
  const found = findDiffCommentRows(state, owner.worktreeId, {
    twin: owner,
    hostId: owner.writeHostId
  })
  return found ? { list: diffCommentRowNotes(found) } : null
}

/**
 * The captured copy as it stands now, or null when it is gone. An unlisted capture resolves as
 * its rows read under the selection it was captured with, never the current one.
 */
export function resolveDiffCommentOwner(
  state: DiffCommentSelectorState,
  owner: DiffCommentOwner
): ResolvedDiffCommentOwner | null {
  if (owner.kind !== 'unlisted') {
    return readResolvedDiffComments(state, owner) ? owner : null
  }
  const resolved = selectDiffCommentView(
    { ...state, activeWorktreeId: owner.worktreeId, activeWorkspaceExecutionHostId: owner.hostId },
    owner.worktreeId
  ).owner
  return resolved && resolved.kind !== 'unlisted' ? resolved : null
}

/** The notes of the captured copy, or undefined when it is gone. */
export function readOwnedDiffComments(
  state: DiffCommentSelectorState,
  owner: DiffCommentOwner
): DiffComment[] | undefined {
  const resolved = resolveDiffCommentOwner(state, owner)
  return resolved ? readResolvedDiffComments(state, resolved)?.list : undefined
}

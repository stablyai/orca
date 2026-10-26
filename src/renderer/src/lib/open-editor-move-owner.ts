import type { OpenFile } from '@/store/slices/editor'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import {
  getFileExplorerOperationOwnerFromState,
  type FileExplorerOwnerState
} from '@/components/right-sidebar/file-explorer-operation-owner'
import { resolveOwner } from './resolve-owner'

/** Track server owner (null for this app) and nested SSH owner (null for server-local, undefined for unknown). */
type FileOwner = { runtimeEnvironmentId: string | null; sshHostId: string | null | undefined }

/** The host a move ran on, from the route its rename was sent through. */
export type EditorMoveOwner = FileOwner & {
  /** The renamed workspace, for tabs that recorded no decisive owner of their own. */
  worktreeId: string | undefined
}

export function editorMoveOwnerFromContext(
  context: Pick<RuntimeFileOperationArgs, 'target' | 'expectedExecutionHostId'>,
  worktreeId: string | undefined
): EditorMoveOwner {
  const expected = parseExecutionHostId(context.expectedExecutionHostId)
  return {
    runtimeEnvironmentId:
      context.target.kind === 'environment' ? context.target.environmentId : null,
    sshHostId:
      expected?.kind === 'ssh' ? expected.id : expected?.kind === 'local' ? null : undefined,
    worktreeId
  }
}

/** Keep the tab’s recorded owner; only explicit SSH is decisive because local/server routes may still resolve to nested SSH through Explorer. */
function openFileOwner(
  state: FileExplorerOwnerState,
  file: Pick<
    OpenFile,
    'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId' | 'worktreeId'
  >
): FileOwner {
  const captured = file.operationProvenance?.generation.route
  const capturedHost = parseExecutionHostId(captured?.executionHostId)
  const runtimeEnvironmentId =
    file.runtimeEnvironmentId !== undefined
      ? file.runtimeEnvironmentId?.trim() || null
      : captured
        ? captured.runtimeEnvironmentId
        : ownerEnvironmentId(state, file.worktreeId)
  return {
    runtimeEnvironmentId,
    sshHostId:
      capturedHost?.kind === 'ssh'
        ? capturedHost.id
        : file.externalSshTargetId
          ? toSshExecutionHostId(file.externalSshTargetId)
          : undefined
  }
}

/** Match a move by path AND owner so another host’s same-ID workspace draft remains untouched. */
export function isOpenFileOnMoveOwner(
  state: FileExplorerOwnerState,
  file: Pick<
    OpenFile,
    'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId' | 'worktreeId'
  >,
  owner: EditorMoveOwner
): boolean {
  const own = openFileOwner(state, file)
  if (own.runtimeEnvironmentId !== owner.runtimeEnvironmentId) {
    return false
  }
  if (own.sshHostId !== undefined && owner.sshHostId !== undefined) {
    return own.sshHostId === owner.sshHostId
  }
  // Why read now, from the rows: a lookup from before the rename, or one following focus, can disagree.
  if (file.worktreeId === owner.worktreeId) {
    return true
  }
  const tabHost = workspaceHost(state, file.worktreeId)
  const moveHost =
    owner.sshHostId === undefined
      ? workspaceHost(state, owner.worktreeId)
      : { runtimeEnvironmentId: owner.runtimeEnvironmentId, sshHostId: owner.sshHostId }
  return (
    tabHost !== null &&
    moveHost !== null &&
    tabHost.runtimeEnvironmentId === moveHost.runtimeEnvironmentId &&
    tabHost.sshHostId === moveHost.sshHostId
  )
}

/** Use Explorer’s current workspace-operation owner, including SSH folder scopes; null for ambiguous twins. */
function workspaceHost(
  state: FileExplorerOwnerState,
  workspaceId: string | undefined
): FileOwner | null {
  const owner = getFileExplorerOperationOwnerFromState(state, workspaceId)
  switch (owner.kind) {
    case 'local':
      return { runtimeEnvironmentId: null, sshHostId: null }
    case 'ssh':
      return { runtimeEnvironmentId: null, sshHostId: toSshExecutionHostId(owner.connectionId) }
    case 'runtime': {
      const host = parseExecutionHostId(owner.executionHostId)
      return {
        runtimeEnvironmentId: owner.environmentId,
        sshHostId: host?.kind === 'ssh' ? host.id : null
      }
    }
    case 'unresolved':
      // A workspace with no rows is this app's, as everywhere; a twin's host can't be told.
      return workspaceId && resolveOwner(state, { workspaceId }).kind === 'missing'
        ? { runtimeEnvironmentId: null, sshHostId: null }
        : null
  }
}

/** The paired server a workspace's rows name, or null for this app, a twin or no row. */
function ownerEnvironmentId(state: FileExplorerOwnerState, workspaceId: string): string | null {
  const match = resolveOwner(state, { workspaceId })
  return match.kind === 'resolved' && match.owner.endpoint.kind === 'environment'
    ? match.owner.endpoint.environmentId
    : null
}

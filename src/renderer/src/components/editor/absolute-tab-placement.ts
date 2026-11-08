import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  findWorkspaceFileRoute,
  type RuntimeWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { chatScratchFileAddress } from '@/runtime/files/addressing/runtime-chat-scratch-file-address'
import {
  grantServesInPlace,
  hostOpensGrantedFilesInPlace,
  isSshWorkspaceGrantRefusal
} from '@/runtime/files/grants/runtime-terminal-artifact-grant'
import { grantRestoredHostFile } from './restored-host-file-grant'

/** Where an absolute-path tab reads from: moved to the workspace holding it, granted by its host, or read as it is. */
export type AbsoluteTabPlacement =
  | { kind: 'move'; route: RuntimeWorkspaceFileRoute }
  | { kind: 'grant'; grantId: string; readOnly: boolean; pairing: number | undefined }
  | { kind: 'read' }

type AbsoluteTabPlacementArgs = {
  state: AppState
  /** The workspace the load is for; a conflict review loads a nested workspace's tab. */
  worktreeId: string | null | undefined
  tab: Pick<OpenFile, 'worktreeId' | 'filePath' | 'terminalArtifactGrantId'>
  executionHostId: ExecutionHostId
  readTarget: RuntimeClientTarget
  runtimeEnvironmentId: string | undefined
}

/**
 * A tab stays in the workspace it was opened in, even when another workspace holds its file:
 * moving it switched the user's workspace. Anyone who can open a tab can already run anything on
 * the host, so the holding workspace is no boundary. This computer reads the path directly; a
 * server reads it through a grant, and moves the tab only where it cannot grant an editable one.
 */
export async function placeAbsoluteTab(
  args: AbsoluteTabPlacementArgs
): Promise<AbsoluteTabPlacement> {
  const { state, worktreeId, tab, executionHostId, readTarget, runtimeEnvironmentId } = args
  // Floating files stay in their panel even when a project also contains the path.
  const route = isFloatingWorkspaceId(worktreeId)
    ? null
    : findWorkspaceFileRoute(state, executionHostId, tab.filePath)
  const movesOut = route !== null && route.worktreeId !== worktreeId
  // Re-owning inside the tab's own workspace (a conflict review's read) switches nothing.
  const leavesTabWorkspace = movesOut && route.worktreeId !== tab.worktreeId
  if (leavesTabWorkspace && executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return { kind: 'read' }
  }
  const grantsHere = runtimeEnvironmentId !== undefined && !chatScratchFileAddress(tab.filePath)
  if (leavesTabWorkspace && grantsHere && readTarget.kind === 'environment') {
    if (tab.terminalArtifactGrantId) {
      return { kind: 'read' }
    }
    // Why unswallowed: an unreachable host fails the load retryably; moving would be permanent.
    if (await hostOpensGrantedFilesInPlace(readTarget.environmentId)) {
      try {
        const granted = await grantHere(args.readTarget, worktreeId, tab.filePath)
        if (grantServesInPlace(granted)) {
          return granted
        }
      } catch (error) {
        // Why: moving is permanent, so only the SSH refusal moves; anything else fails retryably.
        if (!isSshWorkspaceGrantRefusal(error)) {
          throw error
        }
      }
    }
  }
  if (movesOut) {
    return { kind: 'move', route }
  }
  return route === null && grantsHere && !tab.terminalArtifactGrantId
    ? grantHere(readTarget, worktreeId, tab.filePath)
    : { kind: 'read' }
}

async function grantHere(
  readTarget: RuntimeClientTarget,
  worktreeId: string | null | undefined,
  filePath: string
): Promise<
  Extract<AbsoluteTabPlacement, { kind: 'grant' }> & { byteLength?: number; binary?: true }
> {
  const pairing =
    readTarget.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(readTarget.environmentId)
      : undefined
  const granted = await grantRestoredHostFile(readTarget, worktreeId, filePath, pairing)
  return { kind: 'grant', ...granted, pairing }
}

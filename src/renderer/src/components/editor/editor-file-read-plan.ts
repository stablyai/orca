import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile, isWorktreeConnectionResolved } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { getRuntimeFileReadScope } from '@/runtime/runtime-file-routing'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import {
  findWorkspaceFileRoute,
  type RuntimeWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { WORKTREE_OWNER_NOT_READY_ERROR } from './editor-panel-content-types'
import { findRestoredEditorWorkspaceRuntimeOwner } from './restored-editor-workspace-runtime-owner'
import { editorTabFileAccess, isClientLocalReadOnlyTab } from '@/lib/local-file-access'
import type { LocalFileAccess } from '../../../../shared/local-file-access'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { grantRestoredHostFile } from './restored-host-file-grant'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { chatScratchFileAddress } from '@/runtime/runtime-chat-scratch-file-address'

export type EditorFileReadPlan =
  | {
      kind: 'read'
      args: RuntimeFileReadArgs
      readScope: string | undefined
      access: LocalFileAccess | undefined
    }
  /** The file belongs to another owner; the tab must be re-keyed before it can be read. */
  | {
      kind: 'reown'
      route: RuntimeWorkspaceFileRoute
      runtimeEnvironmentId: string | null
    }

/** Routes a tab's disk read to its owning host; `trace.readConnectionId` stays current so callers can classify a thrown error. */
export async function planEditorFileRead({
  id,
  filePath,
  worktreeId,
  relativePath,
  tab,
  wakeWslDistro,
  trace
}: {
  id: string
  filePath: string
  worktreeId?: string
  relativePath?: string
  tab: OpenFile | undefined
  wakeWslDistro?: boolean
  trace: { readConnectionId?: string }
}): Promise<EditorFileReadPlan> {
  const resolvedConnectionId = getConnectionIdForFile(worktreeId ?? null, filePath)
  const connectionId = resolvedConnectionId ?? undefined
  const isLiveTailLogTab = tab?.readOnly === true && tab.liveTail === true
  // Client-local tabs must not inherit workspace SSH/runtime ownership; explicit stamps still route.
  const isClientLocalTab = tab ? isClientLocalReadOnlyTab(tab) : false
  const readTarget: RuntimeClientTarget =
    isClientLocalTab && tab?.runtimeEnvironmentId === undefined
      ? { kind: 'local' }
      : requireRuntimeTargetForFileOwner(
          useAppStore.getState(),
          worktreeId,
          tab?.runtimeEnvironmentId
        )
  const readOwnerEnvironmentId =
    readTarget.kind === 'environment' ? readTarget.environmentId : undefined
  trace.readConnectionId = connectionId
  let readGrantId = tab?.terminalArtifactGrantId
  let readGrantPairing: number | undefined
  const readRelativePath = tab?.relativePath ?? relativePath
  const workspaceRuntimeOwner =
    tab && !isClientLocalTab
      ? findRestoredEditorWorkspaceRuntimeOwner(useAppStore.getState(), tab, worktreeId)
      : null
  if (workspaceRuntimeOwner) {
    return {
      kind: 'reown',
      route: workspaceRuntimeOwner.route,
      runtimeEnvironmentId: workspaceRuntimeOwner.runtimeEnvironmentId
    }
  }
  if (
    !isClientLocalTab &&
    resolvedConnectionId === undefined &&
    !readOwnerEnvironmentId &&
    !isWorktreeConnectionResolved(worktreeId ?? null)
  ) {
    // Unhydrated owners may be remote; fail retryably rather than turning a bad client-local read into terminal access denial.
    throw new Error(WORKTREE_OWNER_NOT_READY_ERROR)
  }
  if (tab?.filePath === filePath && tab.relativePath === filePath) {
    // Absolute paths in SSH workspaces belong to their resolved host, including legacy tabs without terminal-link stamps.
    const externalSshOwnerId =
      tab.externalSshTargetId?.trim() || (isClientLocalTab ? undefined : connectionId)
    const runtimeEnvironmentId = isClientLocalTab ? undefined : readOwnerEnvironmentId
    if (isClientLocalTab) {
      trace.readConnectionId = undefined
    } else {
      const currentState = useAppStore.getState()
      const executionHostId = externalSshOwnerId
        ? toSshExecutionHostId(externalSshOwnerId)
        : runtimeEnvironmentId
          ? toRuntimeExecutionHostId(runtimeEnvironmentId)
          : LOCAL_EXECUTION_HOST_ID
      // Floating files stay in their panel even when a project also contains the path.
      const route = isFloatingWorkspaceId(worktreeId)
        ? null
        : findWorkspaceFileRoute(currentState, executionHostId, filePath)
      if (route && route.worktreeId !== worktreeId) {
        return {
          kind: 'reown',
          route,
          runtimeEnvironmentId: runtimeEnvironmentId ?? null
        }
      }
      if (runtimeEnvironmentId && !route && !readGrantId && !chatScratchFileAddress(filePath)) {
        readGrantPairing =
          readTarget.kind === 'environment'
            ? captureRuntimeEnvironmentRequestRevision(readTarget.environmentId)
            : undefined
        const restored = await grantRestoredHostFile(
          readTarget,
          worktreeId,
          filePath,
          readGrantPairing
        )
        readGrantId = restored.grantId
        // Why: a read-only grant stays off the tab, so its save asks the host again and is refused.
        if (!restored.readOnly) {
          useAppStore.getState().setTerminalArtifactGrant(id, readGrantId)
        }
      }
      if (!externalSshOwnerId) {
        // Client-local external tabs must stay off the workspace’s SSH host.
        trace.readConnectionId = undefined
      }
    }
  }
  const readConnectionId = trace.readConnectionId
  const access = tab ? editorTabFileAccess(useAppStore.getState(), tab) : undefined
  return {
    kind: 'read',
    readScope: getRuntimeFileReadScope(readTarget, readConnectionId),
    access,
    args: {
      target: readTarget,
      filePath,
      relativePath: readRelativePath,
      worktreeId,
      connectionId: readConnectionId,
      expectedExternalSshTargetId: tab?.externalSshTargetId,
      includeLocalLogMetadata: isLiveTailLogTab,
      access,
      terminalArtifactGrantId: readGrantId,
      expectedEnvironmentPairingRevision: readGrantPairing,
      pageOversizedBinary: true,
      ...(wakeWslDistro ? { wakeWslDistro: true } : {})
    }
  }
}

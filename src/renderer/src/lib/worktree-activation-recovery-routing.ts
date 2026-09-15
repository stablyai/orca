import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { createBrowserUuid } from './browser-uuid'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import type { WorktreeStartupPayload } from './worktree-startup-payload'
import type { WorktreeActivationOptions } from './worktree-activation-surface-selection'
import {
  recoverWorkspaceActivation,
  type WorkspaceActivationIdentity
} from './worktree-activation-recovery'
import {
  consumeWorkspaceSurfaceProducerAttempt,
  readWorkspaceSurfaceProducerEntries,
  type WorkspaceSurfaceProducer
} from './workspace-surface-production'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'
import { startWorkspaceActivationSurfaceProducer } from './workspace-activation-surface-producer'

export function ensureFolderWorkspaceInitialTerminal(
  folderWorkspace: FolderWorkspace,
  startup?: WorktreeStartupPayload,
  hostAbsenceConfirmed = false
): string | null {
  return ensureWorktreeHasInitialTerminal(
    useAppStore.getState(),
    folderWorkspaceKey(folderWorkspace.id),
    startup,
    undefined,
    undefined,
    undefined,
    { reseedEmptiedWorkspace: true, hostAbsenceConfirmed }
  )
}

export function hasWorkspaceActivationWork(options?: WorktreeActivationOptions): boolean {
  return Boolean(
    options?.startup || options?.setup || options?.defaultTabs || options?.issueCommand
  )
}

export function createWorkspaceActivationIdentity(
  workspaceKey: string,
  route?: { executionHostId?: ExecutionHostId; runtimeEnvironmentId?: string | null }
): WorkspaceActivationIdentity {
  const state = useAppStore.getState()
  return {
    workspaceKey,
    executionHostId: route?.executionHostId ?? getExecutionHostIdForWorktree(state, workspaceKey),
    runtimeEnvironmentId:
      route && 'runtimeEnvironmentId' in route
        ? (route.runtimeEnvironmentId ?? null)
        : getRuntimeEnvironmentIdForWorktree(state, workspaceKey),
    attemptId: createBrowserUuid()
  }
}

export function settleActivationSeedProducer(
  producer: WorkspaceSurfaceProducer,
  workspaceKey: string,
  primaryTabId: string | null,
  existingSurfaceIds: ReadonlySet<string>
): void {
  const state = useAppStore.getState()
  state.reconcileWorktreeTabModel(workspaceKey)
  const surfaceId =
    primaryTabId ??
    (useAppStore.getState().unifiedTabsByWorktree[workspaceKey] ?? []).find(
      (tab) => !existingSurfaceIds.has(tab.id)
    )?.id ??
    null
  if (surfaceId) {
    producer.materialized({ kind: 'tab', id: surfaceId })
    return
  }
  producer.declined('The initial surface producer did not publish a renderable surface.')
}

export function captureActivationRenderableSurfaceIds(workspaceKey: string): ReadonlySet<string> {
  const state = useAppStore.getState()
  state.reconcileWorktreeTabModel(workspaceKey)
  return new Set(
    (useAppStore.getState().unifiedTabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
  )
}

export function recoverActivatedWorkspace(identity: WorkspaceActivationIdentity): string | null {
  const existingTabIds = new Set(
    (useAppStore.getState().tabsByWorktree[identity.workspaceKey] ?? []).map((tab) => tab.id)
  )
  startWorkspaceActivationSurfaceProducer(identity, { mode: 'explicit' })
  void recoverWorkspaceActivation(identity, { mode: 'explicit' })
  return (
    useAppStore
      .getState()
      .tabsByWorktree[identity.workspaceKey]?.find((tab) => !existingTabIds.has(tab.id))?.id ?? null
  )
}

export function finalizeActivatedWorkspaceSurface(
  identity: WorkspaceActivationIdentity,
  primaryTabId: string | null,
  initialCwd?: string
): string | null {
  if (primaryTabId) {
    for (const entry of readWorkspaceSurfaceProducerEntries(identity)) {
      if (
        entry.result?.kind === 'materialized' &&
        entry.result.surface.kind === 'tab' &&
        entry.result.surface.id === primaryTabId
      ) {
        consumeWorkspaceSurfaceProducerAttempt(entry.attempt.id)
      }
    }
  }
  const settledPrimaryTabId = primaryTabId ?? recoverActivatedWorkspace(identity)
  if (settledPrimaryTabId && initialCwd) {
    useAppStore.getState().queueTabInitialCwd(settledPrimaryTabId, initialCwd)
  }
  return settledPrimaryTabId
}

export function hasOutstandingActivationSurfaceProducer(
  identity: WorkspaceActivationIdentity
): boolean {
  return readWorkspaceSurfaceProducerEntries(identity).some(
    (entry) =>
      entry.result?.kind !== 'materialized' || entry.result.surface.kind === 'workspace-content'
  )
}

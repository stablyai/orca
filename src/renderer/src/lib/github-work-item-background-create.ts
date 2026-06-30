import { toast } from 'sonner'

import { useAppStore } from '@/store'
import {
  beginBackgroundWorktreePreparation,
  continueBackgroundWorktreeCreation
} from '@/lib/worktree-creation-flow'
import {
  buildGitHubWorkItemBackendStartup,
  buildGitHubWorkItemStartupPlan,
  buildInitialGitHubWorkItemRequest,
  type GitHubWorkItemBackgroundStoreSnapshot,
  resolvePreferredQuickAgentForGitHubWorkItem
} from '@/lib/github-work-item-background-request'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import {
  resolveDirectPrStartPoint,
  resolveDirectSetupDecision
} from '@/lib/launch-work-item-direct-preflight'
import { agentLaunchCommandErrorMessage } from '@/lib/launch-work-item-direct-messages'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { evaluateRuntimeCompat } from '../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { GitHubWorkItem, SetupDecision } from '../../../shared/types'
import type { Repo } from '../../../shared/types'
import type { TaskSourceContext, WorkspaceRunContext } from '../../../shared/task-source-context'

export type BackgroundGitHubWorkItemCreateResult =
  | { kind: 'background-started' }
  | { kind: 'error' }
  | {
      kind: 'fallback'
      reason: 'repo-missing' | 'host-unavailable' | 'setup-ask' | 'pr-start-point' | 'agent-startup'
    }

type AppActiveView = ReturnType<typeof useAppStore.getState>['activeView']

type BackgroundGitHubWorkItemCreateDeps = {
  getStore: () => GitHubWorkItemBackgroundStoreSnapshot
  getActiveView: () => AppActiveView
  hasPendingCreate: (creationId: string) => boolean
  isPendingCreateActive: (creationId: string) => boolean
  resolveSetupDecision: typeof resolveDirectSetupDecision
  resolvePrStartPoint: typeof resolveDirectPrStartPoint
  confirmHooks: (
    store: GitHubWorkItemBackgroundStoreSnapshot,
    repoId: string,
    scope: 'setup'
  ) => ReturnType<typeof ensureHooksConfirmed>
  beginBackgroundCreate: typeof beginBackgroundWorktreePreparation
  continueBackgroundCreate: typeof continueBackgroundWorktreeCreation
  activatePendingCreate: (creationId: string) => void
  removePendingCreate: (creationId: string) => void
  setActiveView: (view: AppActiveView) => void
  toastError: (message: string) => void
}

export type BackgroundGitHubWorkItemCreateArgs = {
  item: GitHubWorkItem
  repoId: string
  taskSourceContext?: TaskSourceContext | null
  workspaceRunContext?: WorkspaceRunContext | null
  telemetrySource?: WorktreeCreationRequest['telemetrySource']
  openModalFallback: () => void
}

const DEFAULT_DEPS: BackgroundGitHubWorkItemCreateDeps = {
  getStore: () => useAppStore.getState(),
  getActiveView: () => useAppStore.getState().activeView,
  hasPendingCreate: (creationId) =>
    useAppStore.getState().pendingWorktreeCreations[creationId] != null,
  isPendingCreateActive: (creationId) =>
    useAppStore.getState().activePendingCreationId === creationId,
  resolveSetupDecision: resolveDirectSetupDecision,
  resolvePrStartPoint: resolveDirectPrStartPoint,
  confirmHooks: (store, repoId, scope) =>
    ensureHooksConfirmed(store as ReturnType<typeof useAppStore.getState>, repoId, scope),
  beginBackgroundCreate: beginBackgroundWorktreePreparation,
  continueBackgroundCreate: continueBackgroundWorktreeCreation,
  activatePendingCreate: (creationId) => {
    const store = useAppStore.getState()
    store.setActivePendingWorktreeCreation(creationId)
    store.setActiveView('terminal')
    store.setSidebarOpen(true)
  },
  removePendingCreate: (creationId) =>
    useAppStore.getState().removePendingWorktreeCreation(creationId),
  setActiveView: (view) => useAppStore.getState().setActiveView(view),
  toastError: (message) => toast.error(message)
}

function findPendingGitHubWorkItemCreate(
  store: GitHubWorkItemBackgroundStoreSnapshot,
  request: WorktreeCreationRequest
): string | null {
  if (!request.linkedIssue && !request.linkedPR) {
    return null
  }
  const match = Object.values(store.pendingWorktreeCreations).find((entry) => {
    const pending = entry.request
    return (
      pending.repoId === request.repoId &&
      pending.linkedIssue === request.linkedIssue &&
      pending.linkedPR === request.linkedPR
    )
  })
  return match?.creationId ?? null
}

function repoHostUnavailable(store: GitHubWorkItemBackgroundStoreSnapshot, repo: Repo): boolean {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'ssh') {
    return store.sshConnectionStates.get(host.targetId)?.status !== 'connected'
  }
  if (host?.kind !== 'runtime') {
    return false
  }
  const status = store.runtimeStatusByEnvironmentId.get(host.environmentId)?.status
  if (!status) {
    return true
  }
  if (!status.hostPlatform) {
    return true
  }
  const compatibility = evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
  return compatibility.kind === 'blocked'
}

function abandonStagedCreate(
  creationId: string,
  restoreView: AppActiveView,
  deps: BackgroundGitHubWorkItemCreateDeps
): void {
  // Why: fallback paths abandon the temporary creation surface, so return to the
  // flow that launched it unless the user already activated something else.
  const shouldRestoreView = deps.isPendingCreateActive(creationId)
  deps.removePendingCreate(creationId)
  if (shouldRestoreView) {
    deps.setActiveView(restoreView)
  }
}

export async function createGitHubWorkItemWorkspaceInBackground(
  args: BackgroundGitHubWorkItemCreateArgs,
  deps: BackgroundGitHubWorkItemCreateDeps = DEFAULT_DEPS
): Promise<BackgroundGitHubWorkItemCreateResult> {
  const store = deps.getStore()
  const repo = store.repos.find((candidate) => candidate.id === args.repoId)
  if (!repo) {
    args.openModalFallback()
    return { kind: 'fallback', reason: 'repo-missing' }
  }

  const initialRequest = buildInitialGitHubWorkItemRequest(args, repo)
  const existingPendingCreateId = findPendingGitHubWorkItemCreate(store, initialRequest)
  if (existingPendingCreateId) {
    deps.activatePendingCreate(existingPendingCreateId)
    return { kind: 'background-started' }
  }
  // Why: disconnected hosts make hook and agent probes fall back to skip/no-agent;
  // keep the old composer gate so Retry cannot reuse degraded preflight values.
  if (repoHostUnavailable(store, repo)) {
    args.openModalFallback()
    return { kind: 'fallback', reason: 'host-unavailable' }
  }

  const restoreView = deps.getActiveView()
  const creationId = deps.beginBackgroundCreate(initialRequest)

  try {
    const repoOwnerSettings = getSettingsForRepoRuntimeOwner(store, args.repoId)
    const setupResolution = await deps.resolveSetupDecision(args.repoId, repo, repoOwnerSettings)
    // Why: once the staged row disappears, the user already cancelled or moved
    // on, so every later preflight await must exit without reopening UI.
    if (!deps.hasPendingCreate(creationId)) {
      return { kind: 'background-started' }
    }
    if (setupResolution.kind === 'needs-modal') {
      abandonStagedCreate(creationId, restoreView, deps)
      args.openModalFallback()
      return { kind: 'fallback', reason: 'setup-ask' }
    }

    let baseBranch: string | undefined
    let pushTarget: WorktreeCreationRequest['pushTarget']
    let branchNameOverride: string | undefined
    let compareBaseRef: string | undefined
    if (args.item.type === 'pr' && args.item.number) {
      try {
        const result = await deps.resolvePrStartPoint(
          args.repoId,
          args.item.number,
          repoOwnerSettings,
          args.item
        )
        baseBranch = result.baseBranch
        pushTarget = result.pushTarget
        branchNameOverride = result.branchNameOverride
        compareBaseRef = result.compareBaseRef
        if (!deps.hasPendingCreate(creationId)) {
          return { kind: 'background-started' }
        }
      } catch (error) {
        if (!deps.hasPendingCreate(creationId)) {
          return { kind: 'background-started' }
        }
        deps.toastError(error instanceof Error ? error.message : 'Unable to resolve pull request.')
        abandonStagedCreate(creationId, restoreView, deps)
        args.openModalFallback()
        return { kind: 'fallback', reason: 'pr-start-point' }
      }
    }

    const trustDecision = await deps.confirmHooks(store, args.repoId, 'setup')
    if (!deps.hasPendingCreate(creationId)) {
      return { kind: 'background-started' }
    }
    const setupDecision: SetupDecision =
      trustDecision === 'skip' ? 'skip' : setupResolution.decision
    const agent = await resolvePreferredQuickAgentForGitHubWorkItem(store, repo)
    if (!deps.hasPendingCreate(creationId)) {
      return { kind: 'background-started' }
    }
    const { startupPlan, quickPrompt, quickTelemetry } = buildGitHubWorkItemStartupPlan({
      agent,
      item: args.item,
      repo,
      store
    })
    if (agent && !startupPlan) {
      deps.toastError(agentLaunchCommandErrorMessage())
      abandonStagedCreate(creationId, restoreView, deps)
      args.openModalFallback()
      return { kind: 'fallback', reason: 'agent-startup' }
    }
    const backendStartup = buildGitHubWorkItemBackendStartup(agent, startupPlan, quickTelemetry)

    const request: WorktreeCreationRequest = {
      ...initialRequest,
      ...(baseBranch ? { baseBranch } : {}),
      ...(compareBaseRef ? { compareBaseRef } : {}),
      setupDecision,
      ...(pushTarget ? { pushTarget } : {}),
      agent,
      ...(branchNameOverride ? { branchNameOverride } : {}),
      ...(backendStartup ? { startup: backendStartup } : {}),
      startupPlan,
      quickPrompt,
      quickTelemetry
    }

    deps.continueBackgroundCreate(creationId, request, { revealCreationSurface: false })
    return { kind: 'background-started' }
  } catch (error) {
    if (!deps.hasPendingCreate(creationId)) {
      return { kind: 'background-started' }
    }
    abandonStagedCreate(creationId, restoreView, deps)
    deps.toastError(error instanceof Error ? error.message : 'Unable to prepare workspace.')
    return { kind: 'error' }
  }
}

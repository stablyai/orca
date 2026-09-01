import { useAppStore } from '@/store'
import { resolveTuiAgentConfig } from '../../../shared/custom-tui-agents'
import {
  activateAndRevealWorktree,
  ensureWorktreeHasInitialTerminal,
  type ActivateAndRevealResult
} from '@/lib/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import {
  attachEphemeralVmRuntimeToWorkspace,
  cleanupEphemeralVmRuntimeForFailedCreate,
  prepareRequestForCreate
} from '@/lib/ephemeral-vm-worktree-creation'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import type { CreateWorktreeResult } from '../../../shared/types'
import {
  findPendingLinkedWorkItemCreationId,
  type WorktreeCreationPhase,
  type WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import {
  agentLaunchFailureMessage,
  agentLaunchRequestErrorMessage
} from '@/lib/agent-launch-failure-copy'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { dispatchPreparedWorktreeCreate } from '@/lib/prepared-worktree-create-dispatch'
import {
  getInitialWorktreeCreationPhase,
  getWorktreeCreationIndeterminate
} from '@/lib/worktree-creation-flow-startup'

type ContinueBackgroundWorktreeCreationOptions = {
  revealCreationSurface?: boolean
}

function revealPendingCreation(
  creationId: string,
  request: WorktreeCreationRequest,
  phase: WorktreeCreationPhase
): void {
  const store = useAppStore.getState()
  const indeterminate = getWorktreeCreationIndeterminate(request)
  store.beginPendingWorktreeCreation({
    creationId,
    phase,
    status: 'creating',
    startedAt: Date.now(),
    indeterminate,
    // Why: the creation surface owns the tab strip immediately. Delaying this
    // caused the real workspace tab bar to flash out when the debounce elapsed.
    loaderVisible: true,
    request
  })
  // Why: the creation panel only renders under the terminal view (App content
  // router), so force it active so the panel is what fills the content area.
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
}

async function preflightAgentTrust(
  request: WorktreeCreationRequest,
  path: string,
  connectionId?: string | null
): Promise<void> {
  // Why: trust-gated agents (cursor-agent, copilot) consume the bracketed paste
  // as menu input on first launch. Pre-write the trust artifact before any
  // terminal spawns. Best-effort — the worktree already exists, so a failure
  // here must not strand it.
  if (!request.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  // Why: a custom id inherits its base harness's trust preset; resolve the base
  // before reading the built-in-only config so a raw custom id degrades instead
  // of crashing on an undefined entry (noImplicitAny hides the unsafe index).
  const { settings } = useAppStore.getState()
  const preflight = resolveTuiAgentConfig(
    request.agent,
    settings?.customTuiAgents,
    settings?.deletedCustomTuiAgents
  )?.preflightTrust
  if (!preflight) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: path,
      ...(connectionId ? { connectionId } : {})
    })
  } catch {
    // Best-effort: continue with launch.
  }
}

async function executeWorktreeCreation(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<void> {
  const preparedRequest = await prepareRequestForCreate(creationId, request)
  if (!preparedRequest) {
    return
  }

  let result: CreateWorktreeResult
  try {
    result = await dispatchPreparedWorktreeCreate(creationId, preparedRequest)
  } catch (error) {
    // Why: a missing entry means the user cancelled mid-flight — abandon
    // silently rather than surfacing an error for work they already dismissed.
    if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
      return
    }
    await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest)
    const message = getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error))
    // Why: an error must stay on the same creation surface that owns the faux
    // tab strip, rather than falling back to stale previous-workspace tabs.
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: message,
      ...(preparedRequest.ephemeralVmRecipe ? { request } : {})
    })
    // Why: only toast when the panel isn't already showing this error (the user
    // navigated away), so a visible failure isn't announced twice.
    if (!isPendingCreationSurfaceVisible(creationId)) {
      toast.error(message)
    }
    return
  }

  // A pre-create agent-launch rejection created no worktree; keep the failure on
  // this creation's own surface (never a substitute workspace) with client-safe
  // recovery copy, matching how a git-create error is reported above.
  if (result.created === false) {
    const rejection = result.agentLaunchResult
    const message =
      rejection.status === 'failed'
        ? agentLaunchFailureMessage(rejection.failure)
        : agentLaunchRequestErrorMessage(rejection.requestError)
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: message
    })
    if (!isPendingCreationSurfaceVisible(creationId)) {
      toast.error(message)
    }
    return
  }

  const worktree = result.worktree
  // Why: if the user dismissed/cancelled while the create was in flight, the entry
  // is gone. Git already made the worktree on disk, but don't auto-provision (trust
  // write, terminal, agent, note) work they abandoned — it surfaces as a plain row
  // via worktrees:changed and provisions lazily on first open.
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    return
  }
  await attachEphemeralVmRuntimeToWorkspace(preparedRequest, worktree.id)

  // The host owns the primary agent terminal for any `agentLaunch` create: on
  // `launched` it spawned it (arriving via async hydration), on a post-create
  // `failed` the durable recovery card owns retry. Either way the renderer must
  // never spawn a primary of its own (I9). The host emits agent_started off the
  // launched receipt now that the create path threads the surface telemetry.
  const hostOwnedLaunch = Boolean(preparedRequest.agentLaunch)
  const backendSpawned = result.startupTerminal?.spawned === true

  if (worktree.path) {
    const repoConnectionId =
      useAppStore.getState().repos.find((repo) => repo.id === worktree.repoId)?.connectionId ?? null
    await preflightAgentTrust(preparedRequest, worktree.path, repoConnectionId)
  }

  // `createWorktree` already inserted the real worktree row. Leaving for an app
  // view keeps the create in the background, while selecting another workspace
  // means the user still expects this task-launch handoff when it becomes ready;
  // the entry guard prevents a late trust preflight from reviving a cancelled create.
  const completionState = useAppStore.getState()
  const shouldActivateOnCompletion =
    completionState.pendingWorktreeCreations[creationId] !== undefined &&
    (isPendingCreationSurfaceVisible(creationId) ||
      (completionState.activeView === 'terminal' &&
        completionState.activePendingCreationId === null))

  let activation: ActivateAndRevealResult | false = false
  if (shouldActivateOnCompletion) {
    activation = activateAndRevealWorktree(worktree.id, {
      sidebarRevealBehavior: 'auto',
      ...(result.setup ? { setup: result.setup } : {}),
      ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
      ...(preparedRequest.issueCommand ? { issueCommand: preparedRequest.issueCommand } : {}),
      ...(backendSpawned || hostOwnedLaunch ? { backendStartupTerminalSpawned: true } : {})
    })
  } else {
    // The user moved on. Seed the worktree's setup in the background
    // (setActiveTab only writes global focus for the active worktree, so this is
    // safe) without yanking them back to it.
    ensureWorktreeHasInitialTerminal(
      useAppStore.getState(),
      worktree.id,
      undefined,
      result.setup,
      preparedRequest.issueCommand,
      result.defaultTabs,
      {
        activateCreatedTabs: false,
        ...(backendSpawned || hostOwnedLaunch ? { backendStartupTerminalSpawned: true } : {})
      }
    )
  }

  // Why: clearing synchronously right after activation lets React commit the
  // panel→terminal swap in one frame — no two-row flicker, no empty-terminal flash.
  useAppStore.getState().removePendingWorktreeCreation(creationId, { cleanupVm: false })
  if (shouldActivateOnCompletion && !preparedRequest.suppressTerminalFocusOnCompletion) {
    queueWorkspaceActivationTerminalFocus(worktree.id, activation)
  }

  // Why: awaiting the note IPC before the swap would add a visible round-trip to
  // the panel→terminal transition; it's cosmetic, so it runs last.
  if (preparedRequest.note) {
    try {
      await useAppStore.getState().updateWorktreeMeta(worktree.id, {
        comment: preparedRequest.note
      })
    } catch {
      console.error('Failed to update worktree meta after creation')
    }
  }
}

/**
 * Kick off a worktree create in the background. The caller (the composer) has
 * already resolved every interactive decision into `request`, so this returns
 * immediately and the work outlives the now-closed modal. Progress and errors
 * surface on the pending creation's sidebar row and content panel.
 */
export function runBackgroundWorktreeCreation(request: WorktreeCreationRequest): string {
  const store = useAppStore.getState()
  const existingCreationId = findPendingLinkedWorkItemCreationId(
    store.pendingWorktreeCreations,
    request
  )
  if (existingCreationId) {
    store.setActivePendingWorktreeCreation(existingCreationId)
    store.setActiveView('terminal')
    store.setSidebarOpen(true)
    return existingCreationId
  }
  // Why: crypto.randomUUID is undefined in non-secure browser contexts (LAN web
  // client over plain HTTP). createBrowserUuid falls back to getRandomValues.
  const creationId = createBrowserUuid()
  revealPendingCreation(creationId, request, getInitialWorktreeCreationPhase(request))
  void executeWorktreeCreation(creationId, request)
  return creationId
}

/** Stage a pending entry before async preflight so the UI shows immediate progress. */
export function beginBackgroundWorktreePreparation(request: WorktreeCreationRequest): string {
  const creationId = createBrowserUuid()
  revealPendingCreation(creationId, request, 'preparing')
  return creationId
}

/** Continue a staged pending entry once async preflight has produced a final request. */
export function continueBackgroundWorktreeCreation(
  creationId: string,
  request: WorktreeCreationRequest,
  options: ContinueBackgroundWorktreeCreationOptions = {}
): boolean {
  const store = useAppStore.getState()
  if (!store.pendingWorktreeCreations[creationId]) {
    return false
  }
  // Why: the remote/runtime create path emits no progress events, so the stepped
  // checklist would freeze on step 1. Use the request's captured repo owner so
  // Retry does not change shape when focus moves to another runtime.
  store.updatePendingWorktreeCreation(creationId, {
    phase: getInitialWorktreeCreationPhase(request),
    status: 'creating',
    startedAt: Date.now(),
    error: undefined,
    provisioningLog: undefined,
    request
  })
  // Why: background work-item preflight can finish after the user moved on; keep
  // the pending row alive without reselecting the creation panel in that case.
  if (options.revealCreationSurface !== false) {
    store.setActivePendingWorktreeCreation(creationId)
    store.setActiveView('terminal')
    store.setSidebarOpen(true)
  }
  void executeWorktreeCreation(creationId, request)
  return true
}

/** Re-run a failed creation from its panel, reusing the captured request. */
export function retryBackgroundWorktreeCreation(creationId: string): void {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  if (!entry) {
    return
  }
  store.updatePendingWorktreeCreation(creationId, {
    status: 'creating',
    startedAt: Date.now(),
    phase:
      entry.request.ephemeralVmRecipe && !entry.request.ephemeralVmRuntimeId
        ? 'provisioning-vm'
        : 'fetching',
    error: undefined,
    provisioningLog: undefined
  })
  store.setActivePendingWorktreeCreation(creationId)
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
  void executeWorktreeCreation(creationId, entry.request)
}

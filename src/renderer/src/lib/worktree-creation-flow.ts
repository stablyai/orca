import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  activateAndRevealWorktree,
  ensureWorktreeHasInitialTerminal,
  type ActivateAndRevealResult,
  type WorktreeStartupPayload
} from '@/lib/worktree-activation'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { queueNewWorkspaceTerminalFocus } from '@/lib/new-workspace-terminal-focus'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import type { CreateWorktreeResult } from '../../../shared/types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { createBrowserUuid } from '@/lib/browser-uuid'

// Why: mirrors the startup-opt the composer used to build inline. The renderer
// only seeds the first terminal when the backend did not already spawn it.
function buildStartupOpt(
  request: WorktreeCreationRequest,
  backendSpawned: boolean
): WorktreeStartupPayload | undefined {
  const plan = request.startupPlan
  if (!plan || backendSpawned) {
    return undefined
  }
  return {
    command: plan.launchCommand,
    ...(plan.env ? { env: plan.env } : {}),
    launchConfig: plan.launchConfig,
    ...(plan.launchToken ? { launchToken: plan.launchToken } : {}),
    ...(request.agent ? { launchAgent: request.agent } : {}),
    ...(plan.startupCommandDelivery ? { startupCommandDelivery: plan.startupCommandDelivery } : {}),
    // Why: command-code shows its prompt in the tab status before the first
    // hook fires, so the prompt is threaded through here.
    ...(request.agent === 'command-code' && request.quickPrompt.trim().length > 0
      ? { initialAgentStatus: { agent: request.agent, prompt: request.quickPrompt.trim() } }
      : {}),
    ...(request.quickTelemetry ? { telemetry: request.quickTelemetry } : {})
  }
}

function getWorktreeCreationIndeterminate(request: WorktreeCreationRequest): boolean {
  if (request.worktreeCreateProgressMode) {
    return request.worktreeCreateProgressMode === 'indeterminate'
  }
  return getActiveRuntimeTarget(useAppStore.getState().settings).kind !== 'local'
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
  const preflight = TUI_AGENT_CONFIG[request.agent].preflightTrust
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
  let result: CreateWorktreeResult
  try {
    result = await useAppStore
      .getState()
      .createWorktree(
        request.repoId,
        request.name,
        request.baseBranch,
        request.setupDecision,
        request.sparseCheckout,
        request.telemetrySource,
        request.displayName,
        request.linkedIssue,
        request.linkedPR,
        request.pushTarget,
        request.agent ?? undefined,
        request.linkedLinearIssue,
        request.branchNameOverride,
        request.workspaceStatus,
        request.linkedGitLabMR,
        request.linkedGitLabIssue,
        request.startup,
        request.pendingFirstAgentMessageRename,
        creationId,
        request.linkedLinearIssueWorkspaceId,
        request.linkedLinearIssueOrganizationUrlKey,
        request.linkedBitbucketPR,
        request.linkedAzureDevOpsPR,
        request.linkedGiteaPR,
        request.compareBaseRef
      )
  } catch (error) {
    // Why: a missing entry means the user cancelled mid-flight — abandon
    // silently rather than surfacing an error for work they already dismissed.
    if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
      return
    }
    const message = getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error))
    // Why: an error must stay on the same creation surface that owns the faux
    // tab strip, rather than falling back to stale previous-workspace tabs.
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: message
    })
    // Why: only toast when the panel isn't already showing this error (the user
    // navigated away), so a visible failure isn't announced twice.
    if (useAppStore.getState().activePendingCreationId !== creationId) {
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

  const backendSpawned = result.startupTerminal?.spawned === true
  if (request.startupPlan && !backendSpawned && !request.startupPlan.launchToken) {
    // Why: delayed delivery must target the exact pane spawned from this queued
    // startup, so both halves of the handoff share one renderer-session token.
    request.startupPlan.launchToken = createBrowserUuid()
  }
  const startupOpt = buildStartupOpt(request, backendSpawned)

  if (worktree.path) {
    const repoConnectionId =
      useAppStore.getState().repos.find((repo) => repo.id === worktree.repoId)?.connectionId ?? null
    await preflightAgentTrust(request, worktree.path, repoConnectionId)
  }

  // `createWorktree` already inserted the real worktree row. Whether we steal
  // the view depends on whether the user is still watching this creation.
  const stillActive = useAppStore.getState().activePendingCreationId === creationId

  let activation: ActivateAndRevealResult | false = false
  let primaryTabId: string | null
  if (stillActive) {
    activation = activateAndRevealWorktree(worktree.id, {
      sidebarRevealBehavior: 'auto',
      ...(result.setup ? { setup: result.setup } : {}),
      ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
      ...(startupOpt ? { startup: startupOpt } : {})
    })
    primaryTabId = activation === false ? null : activation.primaryTabId
  } else {
    // The user moved on. Seed the worktree's terminal + setup in the background
    // (setActiveTab only writes global focus for the active worktree, so this is
    // safe) without yanking them back to it.
    primaryTabId = ensureWorktreeHasInitialTerminal(
      useAppStore.getState(),
      worktree.id,
      startupOpt,
      result.setup,
      undefined,
      result.defaultTabs
    )
  }

  // Why: clearing synchronously right after activation lets React commit the
  // panel→terminal swap in one frame — no two-row flicker, no empty-terminal flash.
  useAppStore.getState().removePendingWorktreeCreation(creationId)
  if (request.startupPlan && !backendSpawned) {
    void ensureAgentStartupInTerminal({
      worktreeId: worktree.id,
      primaryTabId,
      startup: request.startupPlan
    })
  }
  if (stillActive && !request.suppressTerminalFocusOnCompletion) {
    queueNewWorkspaceTerminalFocus(worktree.id, activation)
  }

  // Why: awaiting the note IPC before the swap would add a visible round-trip to
  // the panel→terminal transition; it's cosmetic, so it runs last.
  if (request.note) {
    try {
      await useAppStore.getState().updateWorktreeMeta(worktree.id, { comment: request.note })
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
export function runBackgroundWorktreeCreation(request: WorktreeCreationRequest): void {
  // Why: crypto.randomUUID is undefined in non-secure browser contexts (LAN web
  // client over plain HTTP). createBrowserUuid falls back to getRandomValues.
  const creationId = createBrowserUuid()
  const store = useAppStore.getState()
  // Why: the remote/runtime create path emits no progress events, so the stepped
  // checklist would freeze on step 1. Use the request's captured repo owner so
  // Retry does not change shape when focus moves to another runtime.
  const indeterminate = getWorktreeCreationIndeterminate(request)
  store.beginPendingWorktreeCreation({
    creationId,
    phase: 'fetching',
    status: 'creating',
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
  void executeWorktreeCreation(creationId, request)
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
    phase: 'fetching',
    error: undefined
  })
  store.setActivePendingWorktreeCreation(creationId)
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
  void executeWorktreeCreation(creationId, entry.request)
}

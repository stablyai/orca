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

// Why: most local creates finish in well under this window; holding the loader
// back this long means a fast create swaps prior content → terminal with no
// loader flash, while a genuinely slow create still surfaces one promptly.
const CREATION_LOADER_DEBOUNCE_MS = 280

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
    // Why: command-code shows its prompt in the tab status before the first
    // hook fires, so the prompt is threaded through here.
    ...(request.agent === 'command-code' && request.quickPrompt.trim().length > 0
      ? { initialAgentStatus: { agent: request.agent, prompt: request.quickPrompt.trim() } }
      : {}),
    ...(request.quickTelemetry ? { telemetry: request.quickTelemetry } : {})
  }
}

async function preflightAgentTrust(request: WorktreeCreationRequest, path: string): Promise<void> {
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
    await window.api.agentTrust.markTrusted({ preset: preflight, workspacePath: path })
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
        request.linkedLinearIssueOrganizationUrlKey
      )
  } catch (error) {
    // Why: a missing entry means the user cancelled mid-flight — abandon
    // silently rather than surfacing an error for work they already dismissed.
    if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
      return
    }
    const message = getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error))
    // Why: an error must surface immediately even if it lands before the loader
    // debounce fired, so force the loader visible alongside the error.
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: message,
      loaderVisible: true
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
  const startupOpt = buildStartupOpt(request, backendSpawned)

  if (worktree.path) {
    await preflightAgentTrust(request, worktree.path)
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
  if (stillActive) {
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
  const creationId = crypto.randomUUID()
  const store = useAppStore.getState()
  // Why: the remote/runtime create path emits no progress events, so the stepped
  // checklist would freeze on step 1. Mark it indeterminate up front so the panel
  // shows a single spinner instead of implying phase progress that never arrives.
  const indeterminate = getActiveRuntimeTarget(store.settings).kind !== 'local'
  store.beginPendingWorktreeCreation({
    creationId,
    phase: 'fetching',
    status: 'creating',
    indeterminate,
    loaderVisible: false,
    request
  })
  // Why: the creation panel only renders under the terminal view (App content
  // router), so force it active so the panel is what fills the content area.
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
  // Why: debounce the loader so a fast create never flashes it. The prior
  // workspace stays visible until the delay elapses; if the create resolves
  // first, removePendingWorktreeCreation clears the entry and this update no-ops.
  setTimeout(() => {
    useAppStore.getState().updatePendingWorktreeCreation(creationId, { loaderVisible: true })
  }, CREATION_LOADER_DEBOUNCE_MS)
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

import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import type {
  WorktreeCreationPhase,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

// Why: mirrors the startup-opt the composer used to build inline. The renderer
// only seeds the first terminal when the backend did not already spawn it.
export function buildWorktreeCreationStartupOpt(
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
    ...(plan.draftPrompt ? { draftPrompt: plan.draftPrompt } : {}),
    // Why: view-mode only. An argv-prefill plan sets no draftPrompt, so this is
    // the sole signal that this launch starts with unsent context in the TUI.
    ...(request.launchDraftPrompt ? { launchDraftText: request.launchDraftPrompt } : {}),
    ...(plan.startupCommandDelivery ? { startupCommandDelivery: plan.startupCommandDelivery } : {}),
    // Why: command-code shows its prompt in the tab status before the first
    // hook fires, so the prompt is threaded through here.
    ...(request.agent === 'command-code' && request.quickPrompt.trim().length > 0
      ? { initialAgentStatus: { agent: request.agent, prompt: request.quickPrompt.trim() } }
      : {}),
    ...(request.quickTelemetry ? { telemetry: request.quickTelemetry } : {})
  }
}

export function getWorktreeCreationIndeterminate(request: WorktreeCreationRequest): boolean {
  if (request.worktreeCreateProgressMode) {
    return request.worktreeCreateProgressMode === 'indeterminate'
  }
  return getActiveRuntimeTarget(useAppStore.getState().settings).kind !== 'local'
}

export function getInitialWorktreeCreationPhase(
  request: WorktreeCreationRequest
): WorktreeCreationPhase {
  return request.ephemeralVmRecipe && !request.ephemeralVmRuntimeId ? 'provisioning-vm' : 'fetching'
}

import { useAppStore } from '@/store'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import type {
  WorktreeCreationPhase,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

// Match composer startup options; seed in renderer only when backend did not launch a terminal.
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
    // This view-only marker identifies unsent TUI context even for argv-prefill plans without draftPrompt.
    ...(plan.startupCommandDelivery ? { startupCommandDelivery: plan.startupCommandDelivery } : {}),
    // Command Code needs prompt status before its first hook; carry it through startup.
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
  // Why: progress follows the host the workspace is created on, not the focused one.
  const target = request.executionHostId
    ? ipcOrRuntimeTargetForHostId(request.executionHostId)
    : runtimeTargetForRepoOwner(useAppStore.getState(), request.repoId)
  return target?.kind !== 'local'
}

export function getInitialWorktreeCreationPhase(
  request: WorktreeCreationRequest
): WorktreeCreationPhase {
  if (request.hookPreparation) {
    return 'preparing'
  }
  return request.ephemeralVmRecipe && !request.ephemeralVmRuntimeId ? 'provisioning-vm' : 'fetching'
}

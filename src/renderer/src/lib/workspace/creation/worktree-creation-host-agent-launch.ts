import { useAppStore } from '@/store'
import { resolveBackendDraftStartup } from '@/lib/workspace/creation/worktree-draft-startup-view-mode'
import { toast } from 'sonner'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/workspace/creation/worktree-startup-payload'
import { buildWorktreeCreationStartupOpt } from '@/lib/workspace/creation/worktree-creation-flow-startup'
import { agentLaunchPaneNoticeText } from '@/components/terminal-pane/launch-outcome/agent-launch-pane-notice-text'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { InitialTerminalOptions } from '@/lib/workspace/activation/worktree-activation-store-contract'
import type {
  CreateWorktreeCallOptions,
  CreatedWorktreeResult,
  HostAgentLaunch
} from '@/store/slices/worktrees/create/worktree-create-payload'

/** Use host settings for terminal agents; chats have a separate host path. VM hosts lack user settings, and drafts stay desktop-planned because host startupDraft can substitute a disabled agent. */
export function hostPlannableAgentLaunch(
  request: WorktreeCreationRequest
): HostAgentLaunch | undefined {
  if (
    !request.agent ||
    request.launchInputs !== undefined ||
    !request.startupPlan ||
    request.launchDraftPrompt ||
    request.agentLaunchRoute === 'structured-native-chat' ||
    request.ephemeralVmRecipe
  ) {
    return undefined
  }
  const launchSource = request.quickTelemetry?.launch_source
  return {
    agent: request.agent,
    ...(request.quickPrompt.trim() ? { prompt: request.quickPrompt } : {}),
    ...(launchSource ? { launchSource } : {})
  }
}

type CreationTerminalOptions = Pick<
  InitialTerminalOptions,
  'worktreeCreationId' | 'createNewTerminalForStartup' | 'backendStartupTerminalSpawned'
>

/** A terminal opened mid-create must not swallow the agent launch; only this creation may seed past its pending guard. */
export function windowStartupAfterCreate(
  creationId: string,
  request: WorktreeCreationRequest,
  result: CreatedWorktreeResult
): {
  startup?: WorktreeStartupPayload
  agent: TuiAgent | null
  terminalOptions: CreationTerminalOptions
} {
  const backendSpawned = result.startupTerminal?.spawned === true
  const plan = planWindowStartup(request, result, backendSpawned)
  return {
    ...plan,
    terminalOptions: {
      worktreeCreationId: creationId,
      ...(plan.startup ? { createNewTerminalForStartup: true } : {}),
      ...(backendSpawned ? { backendStartupTerminalSpawned: true } : {})
    }
  }
}

/** Host-planned launches also own window startup/recovery; starting either here could duplicate the agent. */
function planWindowStartup(
  request: WorktreeCreationRequest,
  result: CreatedWorktreeResult,
  backendSpawned: boolean
): { startup?: WorktreeStartupPayload; agent: TuiAgent | null } {
  if (result.hostPlannedStartup) {
    if (!backendSpawned) {
      // No reported terminal does not prove the host window started no agent.
      toast.error(agentLaunchPaneNoticeText({ kind: 'unconfirmed' }, request.agent))
    }
    return { agent: null }
  }
  if (!backendSpawned) {
    const token =
      request.creationStartup?.launchToken ??
      request.startupPlan?.launchToken ??
      createBrowserUuid()
    if (request.creationStartup) {
      request.creationStartup.launchToken = token
    }
    if (request.startupPlan) {
      request.startupPlan.launchToken = token
    }
  }
  if (request.agentLaunchRoute === 'structured-native-chat') {
    return { agent: request.agent }
  }
  return { startup: buildWorktreeCreationStartupOpt(request, backendSpawned), agent: request.agent }
}

export function worktreeCreationAgentLaunchOptions(
  request: WorktreeCreationRequest
): Pick<CreateWorktreeCallOptions, 'creationAgentLaunch' | 'legacyStartup'> {
  if (
    request.agentLaunchRoute === 'structured-native-chat' ||
    request.ephemeralVmCheckoutMode === 'provisioned-root' ||
    request.ephemeralVmRecipe ||
    !request.agent ||
    (request.launchInputs === undefined && !request.launchDraftPrompt)
  ) {
    return {}
  }
  const intent = request.creationStartup
  return {
    creationAgentLaunch: {
      agent: request.agent,
      prompt: request.quickPrompt,
      draft: request.launchDraftPrompt,
      inputs: request.launchInputs,
      launchSource: request.quickTelemetry?.launch_source
    },
    ...(intent
      ? {
          legacyStartup: () => {
            let legacy
            try {
              legacy = intent.legacy()
            } catch (error) {
              throw new WorktreeLegacyPreparationError(error)
            }
            request.startupPlan = legacy.startupPlan
            request.startup = legacy.backendStartup
            return resolveBackendDraftStartup(request)
          }
        }
      : {})
  }
}

export class WorktreeLegacyPreparationError extends Error {
  constructor(readonly preparationError: unknown) {
    super('Workspace launch preparation failed', { cause: preparationError })
  }
}

export function recoverWorktreeLegacyPreparation(
  creationId: string,
  request: WorktreeCreationRequest,
  error: unknown
): boolean {
  if (
    !(error instanceof WorktreeLegacyPreparationError) ||
    !request.creationStartup?.onLegacyPreparationFailure
  ) {
    return false
  }
  useAppStore.getState().removePendingWorktreeCreation(creationId)
  request.creationStartup.onLegacyPreparationFailure(error.preparationError)
  return true
}

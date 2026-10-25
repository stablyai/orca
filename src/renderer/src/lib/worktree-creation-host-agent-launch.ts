import { toast } from 'sonner'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { agentLaunchPaneNoticeText } from '@/components/terminal-pane/agent-launch-pane-notice-text'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { InitialTerminalOptions } from '@/lib/worktree-activation-store-contract'
import type {
  CreatedWorktreeResult,
  HostAgentLaunch
} from '@/store/slices/worktrees/create/worktree-create-payload'

/** Use host settings for terminal agents; chats have a separate host path. VM hosts lack user settings, and drafts stay desktop-planned because host startupDraft can substitute a disabled agent. */
export function hostPlannableAgentLaunch(
  request: WorktreeCreationRequest
): HostAgentLaunch | undefined {
  if (
    !request.agent ||
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
  if (request.startupPlan && !backendSpawned && !request.startupPlan.launchToken) {
    // Share one renderer-session token so delayed delivery targets the pane this queued startup spawns.
    request.startupPlan.launchToken = createBrowserUuid()
  }
  if (request.agentLaunchRoute === 'structured-native-chat') {
    return { agent: request.agent }
  }
  return { startup: buildWorktreeCreationStartupOpt(request, backendSpawned), agent: request.agent }
}

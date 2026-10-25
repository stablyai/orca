import { toast } from 'sonner'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { agentLaunchPaneNoticeText } from '@/components/terminal-pane/agent-launch-pane-notice-text'
import type { TuiAgent } from '../../../shared/tui-agent'
import type {
  CreatedWorktreeResult,
  HostAgentLaunch
} from '@/store/slices/worktrees/create/worktree-create-payload'

/** The composer's terminal agent, for a host that plans it from its own settings. Chat launches
 *  have their own host path; VM recipes keep the desktop plan, as their hosts hold no user settings.
 *  Drafts stay desktop-planned: a host's `startupDraft` swaps a host-disabled agent for another. */
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

/** What the window itself starts in the created workspace: its startup and the agent its terminal
 *  recovery may relaunch. A host that planned the launch owns it, so the window starts neither. */
export function windowStartupAfterCreate(
  request: WorktreeCreationRequest,
  result: CreatedWorktreeResult,
  backendSpawned: boolean
): { startup?: WorktreeStartupPayload; agent: TuiAgent | null } {
  if (result.hostPlannedStartup) {
    if (!backendSpawned) {
      // Why: the host reported no agent terminal, yet its own window may still have started one.
      toast.error(agentLaunchPaneNoticeText({ kind: 'unconfirmed' }, request.agent))
    }
    return { agent: null }
  }
  if (request.startupPlan && !backendSpawned && !request.startupPlan.launchToken) {
    // Why: delayed delivery must target the exact pane spawned from this queued
    // startup, so both halves of the handoff share one renderer-session token.
    request.startupPlan.launchToken = createBrowserUuid()
  }
  if (request.agentLaunchRoute === 'structured-native-chat') {
    return { agent: request.agent }
  }
  return { startup: buildWorktreeCreationStartupOpt(request, backendSpawned), agent: request.agent }
}

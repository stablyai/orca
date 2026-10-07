import { useAppStore } from '@/store'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import type { AgentLaunchRoute } from '@/lib/agent-launch-routing'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import type { StructuredLaunchTerminal } from '@/lib/structured-agent-session-paired-admission'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'

export type WorktreeCreationStructuredSessionResult = {
  accepted: boolean
  cancelled: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}

type LaunchStructuredWorktreeSessionArgs = {
  creationId: string
  request: WorktreeCreationRequest
  /** Required: a non-structured route opens no session here, so the caller must have gated on it. */
  agentLaunchRoute: AgentLaunchRoute
  worktreeId: string
  shouldActivateOnCompletion: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}

/**
 * A paired server's "no" to a create the user moved away from opens the agent terminal the way a
 * background terminal create does: in place, without selecting the workspace (#23974). A create the
 * user is still watching keeps the default, which opens it as a new agent tab there.
 */
function openBackgroundDeclinedTerminal(
  args: LaunchStructuredWorktreeSessionArgs
): StructuredLaunchTerminal {
  ensureWebRuntimeWorktreeTerminalAfterWake(args.worktreeId, {
    startup: buildWorktreeCreationStartupOpt(args.request, false),
    agent: args.request.agent,
    activate: false
  })
  return { opened: true }
}

export async function launchStructuredWorktreeSession(
  args: LaunchStructuredWorktreeSessionArgs
): Promise<WorktreeCreationStructuredSessionResult> {
  let { activation, primaryTabId } = args
  const settled = { accepted: true, cancelled: false }
  const { agent } = args.request
  // The composer's route already asked the host whether it runs this agent as a chat.
  if (!agent || args.agentLaunchRoute !== 'structured-native-chat') {
    return { ...settled, activation, primaryTabId }
  }
  const isCancelled = (): boolean =>
    !useAppStore.getState().pendingWorktreeCreations[args.creationId]
  if (isCancelled()) {
    return { ...settled, cancelled: true, activation, primaryTabId }
  }
  // Why: the composer decided route and delivery mode before the worktree existed, and the request
  // carries that verdict in renderer memory for the life of the create; re-entering with it is what
  // keeps a retry from re-resolving against a host that has changed since.
  const plan = adoptAgentSessionLaunchVerdict({
    route: args.agentLaunchRoute,
    // One create is one user action: a retry of it re-delivers the same request.
    requestId: args.creationId,
    agent,
    prompt: args.request.launchDraftPrompt ?? args.request.quickPrompt,
    ...(args.request.promptDelivery ? { promptDelivery: args.request.promptDelivery } : {})
  })
  const abandoned = new AbortController()
  let ownershipTransferred = false
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!ownershipTransferred && !state.pendingWorktreeCreations[args.creationId]) {
      abandoned.abort()
    }
  })
  try {
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { signal: abandoned.signal },
      target: { worktreeId: args.worktreeId },
      activate: args.shouldActivateOnCompletion,
      ...(args.shouldActivateOnCompletion
        ? {}
        : { onHostDeclined: () => openBackgroundDeclinedTerminal(args) }),
      beforeOpen: () => {
        // Why: cancellation can arrive through the launch signal while reveal is running, before
        // the pending-creation store snapshot has caught up.
        if (abandoned.signal.aborted || isCancelled()) {
          return false
        }
        if (args.shouldActivateOnCompletion && !activation) {
          try {
            activation = activateAndRevealWorktree(args.worktreeId, {
              providesInitialSurface: true
            })
          } catch (error) {
            // Why: without a revealed workspace the provisional tab has no visible owner.
            console.error('worktree create: structured chat reveal failed', args.worktreeId, error)
            activation = false
            return false
          }
          if (activation === false) {
            return false
          }
          primaryTabId = activation.primaryTabId
        }
        return !abandoned.signal.aborted && !isCancelled()
      }
    })
    ownershipTransferred = launch !== null
    if (launch) {
      primaryTabId = launch.tab?.id ?? primaryTabId
    }
  } catch (error) {
    // Why: nothing awaits this creation's caller, so an escaped throw would strand the panel
    // mid-create.
    console.error('worktree create: structured chat tab failed to open', args.worktreeId, error)
    return { ...settled, activation, primaryTabId }
  } finally {
    unsubscribe()
  }
  return { ...settled, activation, primaryTabId }
}

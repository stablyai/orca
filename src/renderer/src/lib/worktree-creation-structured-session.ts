import { useAppStore } from '@/store'
import type { ActivateAndRevealResult } from '@/lib/worktree-activation'
import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { AgentLaunchRoute } from '@/lib/agent-launch-routing'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { launchAgentSession } from '@/lib/launch-agent-session'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'

export type WorktreeCreationStructuredSessionResult = {
  accepted: boolean
  cancelled: boolean
  visibilityUnknown: boolean
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
  /** Retained for callers/tests until Task 3 removes the prebuilt TUI payload. */
  fallbackStartupOpt?: WorktreeStartupPayload
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
  recoverUnknownLaunch?: boolean
}

/** Route quick-create's structured branch through the shared launcher. It owns refusal fallback,
 * cancellation retirement, trust/meta writes, and reveal/background surface creation. */
export async function launchStructuredWorktreeSession(
  args: LaunchStructuredWorktreeSessionArgs
): Promise<WorktreeCreationStructuredSessionResult> {
  const { activation, primaryTabId } = args
  const settled = { accepted: true, cancelled: false, visibilityUnknown: false }
  const { agent } = args.request
  if (args.agentLaunchRoute !== 'structured-native-chat' || !isAgentSessionHandleProvider(agent)) {
    return { ...settled, activation, primaryTabId }
  }
  if (!useAppStore.getState().pendingWorktreeCreations[args.creationId]) {
    return { ...settled, cancelled: true, activation, primaryTabId }
  }
  const launchPlan = adoptAgentSessionLaunchVerdict({
    route: args.agentLaunchRoute,
    agent,
    worktreeId: args.worktreeId,
    ...(args.recoverUnknownLaunch
      ? {}
      : {
          prompt: args.request.launchDraftPrompt ?? args.request.quickPrompt,
          ...(args.request.promptDelivery ? { promptDelivery: args.request.promptDelivery } : {})
        }),
    ...(args.recoverUnknownLaunch ? { reconcileUnknownLaunch: args.recoverUnknownLaunch } : {})
  })
  const abandoned = new AbortController()
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!state.pendingWorktreeCreations[args.creationId]) {
      abandoned.abort()
    }
  })
  let outcome: Awaited<ReturnType<typeof launchAgentSession>>
  try {
    outcome = await launchAgentSession({
      agent,
      workspaceId: args.worktreeId,
      ...(args.recoverUnknownLaunch
        ? {}
        : {
            prompt: args.request.launchDraftPrompt ?? args.request.quickPrompt,
            ...(args.request.promptDelivery ? { promptDelivery: args.request.promptDelivery } : {})
          }),
      visibility: args.shouldActivateOnCompletion ? 'reveal' : 'background',
      launchSource: args.request.quickTelemetry?.launch_source ?? 'new_workspace_composer',
      launchPlan,
      ...(args.fallbackStartupOpt ? { terminalStartup: args.fallbackStartupOpt } : {}),
      pendingFirstAgentMessageRename: args.request.pendingFirstAgentMessageRename,
      reconcileUnknownLaunch: args.recoverUnknownLaunch,
      signal: abandoned.signal
    })
  } catch {
    unsubscribe()
    return { ...settled, activation, primaryTabId }
  }
  unsubscribe()

  switch (outcome.kind) {
    case 'structured':
      return {
        ...settled,
        activation:
          args.shouldActivateOnCompletion && activation === false
            ? { primaryTabId: null }
            : activation,
        primaryTabId
      }
    case 'terminal':
      return { ...settled, accepted: false, activation, primaryTabId: outcome.tabId }
    case 'visibility-unknown':
      return { ...settled, visibilityUnknown: true, activation, primaryTabId }
    case 'cancelled':
      return {
        ...settled,
        accepted: outcome.surface === undefined,
        cancelled: true,
        activation,
        primaryTabId: outcome.surface?.tabId ?? primaryTabId
      }
    case 'failed':
      // A failed launch leaves the creation accepted; the launcher owns the toast.
      return { ...settled, activation, primaryTabId }
  }
}

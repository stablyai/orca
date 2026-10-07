import { useAppStore } from '@/store'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import {
  awaitStructuredRouteHostAnswer,
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan,
  type AgentSessionLaunchRequest
} from '@/lib/agent-session-launch-plan'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from '@/lib/launch-agent-in-new-tab'

/** How long a new tab waits for its host's answer before deciding without it; the same bound a
 *  local chat's admission waits. */
export const HOST_ANSWER_WAIT_MS = 3_000

const DELIVERED: StructuredPromptDeliveryResult = { delivered: true, failureNotified: false }
const NOT_DELIVERED: StructuredPromptDeliveryResult = { delivered: false, failureNotified: false }

type AwaitingHostAnswer = { awaited: Promise<void>; replan: () => AgentSessionLaunchPlan }

/** The new tab's route: the caller's own plan, a plan decided now, or, when the chat route waits
 *  only on the host's agent list or this computer's runtime capabilities, the wait for them and
 *  the plan decided after. */
export function routeNewTabLaunch(
  store: Parameters<typeof planAgentSessionLaunch>[0],
  args: LaunchAgentInNewTabArgs,
  request: Omit<AgentSessionLaunchRequest, 'requestId'>
): { plan: AgentSessionLaunchPlan | undefined } | AwaitingHostAnswer {
  const { requestId } = args
  if (requestId === undefined) {
    return { plan: args.agentSessionLaunchPlan }
  }
  const awaited = awaitStructuredRouteHostAnswer(store, request, HOST_ANSWER_WAIT_MS)
  return awaited
    ? {
        awaited,
        replan: () => planAgentSessionLaunch(useAppStore.getState(), { requestId, ...request })
      }
    : { plan: planAgentSessionLaunch(store, { requestId, ...request }) }
}

/**
 * Opens nothing until the host answered or the wait ran out, then launches on the route decided
 * with what is known: the chat, or the terminal. The first launch after startup is not sent to the
 * terminal by an answer that was still loading.
 */
export function launchOnceHostAnswered(
  route: AwaitingHostAnswer,
  args: LaunchAgentInNewTabArgs,
  startupPlan: AgentStartupPlan,
  relaunch: (args: LaunchAgentInNewTabArgs) => LaunchAgentInNewTabResult
): LaunchAgentInNewTabResult {
  if (args.beforeSurfaceOpen?.({ kind: 'host-published' }) === false) {
    return null
  }
  const opened = route.awaited.then(() =>
    relaunch({
      ...args,
      beforeSurfaceOpen: undefined,
      requestId: undefined,
      agentSessionLaunchPlan: route.replan()
    })
  )
  const structuredSettlement = opened.then(
    (result): Promise<StructuredAgentLaunchSettlement> | StructuredAgentLaunchSettlement =>
      !result
        ? { kind: 'cancelled', sessionId: null }
        : (result.structuredSettlement ?? { kind: 'terminal' }),
    (error: unknown): StructuredAgentLaunchSettlement => ({ kind: 'failed', error })
  )
  const deliversPrompt =
    Boolean(args.prompt?.trim()) && (args.promptDelivery ?? 'auto-submit') !== 'draft'
  return {
    surface: { kind: 'host-published' },
    startupPlan,
    pasteDraftAfterLaunch: false,
    structuredSettlement,
    ...(deliversPrompt
      ? {
          promptDeliveryResult: opened.then(
            (result) => (result ? (result.promptDeliveryResult ?? DELIVERED) : NOT_DELIVERED),
            () => NOT_DELIVERED
          )
        }
      : {})
  }
}

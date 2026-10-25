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

/** Bound host-fact waiting to the same deadline as local chat admission. */
export const HOST_ANSWER_WAIT_MS = 3_000

const DELIVERED: StructuredPromptDeliveryResult = { delivered: true, failureNotified: false }
const NOT_DELIVERED: StructuredPromptDeliveryResult = { delivered: false, failureNotified: false }

type AwaitingHostAnswer = { awaited: Promise<void>; replan: () => AgentSessionLaunchPlan }

/** Reuse caller plans; otherwise await missing host agents/local capabilities before deciding the route. */
export function routeNewTabLaunch(
  store: Parameters<typeof planAgentSessionLaunch>[0],
  args: LaunchAgentInNewTabArgs,
  request: Omit<AgentSessionLaunchRequest, 'requestId'>
): { plan: AgentSessionLaunchPlan | undefined } | AwaitingHostAnswer {
  const { requestId } = args
  if (requestId === undefined) {
    return { plan: args.agentSessionLaunchPlan }
  }
  const awaited = request.requestedSurface
    ? null
    : awaitStructuredRouteHostAnswer(store, request, HOST_ANSWER_WAIT_MS)
  return awaited
    ? {
        awaited,
        replan: () => planAgentSessionLaunch(useAppStore.getState(), { requestId, ...request })
      }
    : { plan: planAgentSessionLaunch(store, { requestId, ...request }) }
}

/** Open only after host facts settle or time out so startup loading cannot spuriously force the first launch into a terminal. */
export function launchOnceHostAnswered(
  route: AwaitingHostAnswer,
  args: LaunchAgentInNewTabArgs,
  startupPlan: AgentStartupPlan,
  relaunch: (args: LaunchAgentInNewTabArgs) => LaunchAgentInNewTabResult
): LaunchAgentInNewTabResult {
  if (args.beforeSurfaceOpen?.({ kind: 'host-published' }) === false) {
    args.focusIntent?.cancel()
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
    (error: unknown): StructuredAgentLaunchSettlement => {
      args.focusIntent?.cancel()
      return { kind: 'failed', error }
    }
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

import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { useAppStore } from '@/store'
import {
  awaitStructuredRouteHostAnswer,
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan,
  type AgentSessionLaunchRequest
} from '@/lib/agent-session-launch-plan'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import type { StructuredLaunchTerminal } from '@/lib/structured-agent-session-launch-admission'

/** The user action this launch serves: minted where that action is handled, or carried by the
 *  route the caller already planned for it. */
export type LaunchAgentInNewTabRequest =
  | { requestId: AgentLaunchRequestId; agentSessionLaunchPlan?: undefined }
  | {
      /** Keeps a preflighted route authoritative across workspace creation. */
      agentSessionLaunchPlan: AgentSessionLaunchPlan
      requestId?: undefined
    }

/** `host-published`: the surface opens once its host answers; `local-chat` opened before it did. */
export type AgentLaunchSurface =
  | { kind: 'local-terminal'; tabId: string }
  | { kind: 'local-chat'; tabId: string }
  | { kind: 'host-published' }

export type LaunchAgentInNewTabResult = {
  surface: AgentLaunchSurface
  startupPlan?: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
  /** Structured route only: what the launch did once it settled. The call stays synchronous. */
  terminalCompletion?: StructuredLaunchTerminal['completion']
  structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
} | null

export type AgentTabLaunchOutcome =
  | LaunchAgentInNewTabResult
  | { refused: StructuredPromptDeliveryResult }

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.surface.kind === 'host-published'
}

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
  relaunch: (args: LaunchAgentInNewTabArgs) => AgentTabLaunchOutcome
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
      !result || 'refused' in result
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
    pasteDraftAfterLaunch: false,
    structuredSettlement,
    ...(deliversPrompt
      ? {
          promptDeliveryResult: opened.then(
            (result) =>
              result && 'refused' in result
                ? result.refused
                : result
                  ? (result.promptDeliveryResult ?? DELIVERED)
                  : NOT_DELIVERED,
            () => NOT_DELIVERED
          )
        }
      : {})
  }
}

import type { AgentStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-startup'
import { useAppStore } from '@/store/index'
import { agentTabLaunchStore } from '@/lib/agent-session/launch/new-tab/launch-agent-execution-context'
import {
  awaitStructuredRouteHostAnswer,
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan,
  type AgentSessionLaunchRequest
} from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { StructuredAgentLaunchSettlement } from '@/lib/agent-session/launch/continuation/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/agent-session/launch/structured-agent-session-launch-callers'
import type { LaunchAgentInNewTabArgs } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-args'
import type { StructuredLaunchTerminal } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'

/** The user action this launch serves: minted where that action is handled, or carried by the
 *  route the caller already planned for it. */
export type LaunchAgentInNewTabRequest =
  | { requestId: string; agentSessionLaunchPlan?: undefined }
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
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  /** Structured route only: what the launch did once it settled. The call stays synchronous. */
  terminalCompletion?: StructuredLaunchTerminal['completion']
  structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
} | null

export type AgentTabLaunchOutcome =
  | LaunchAgentInNewTabResult
  | {
      refused: StructuredPromptDeliveryResult
      /** What to do instead, when the caller's visible surface presents the refusal itself. */
      recovery?: string
    }

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

/** Both terminal adapters retain the same actual-create receipt behind their early acceptance. */
export async function terminalLaunchOpened(terminal: StructuredLaunchTerminal): Promise<boolean> {
  return terminal.completion
    ? (await terminal.completion).outcome.status === 'created'
    : terminal.opened
}

/** Surface acceptance can precede preparation; only its existing completion can claim a create. */
export async function settleAgentTabLaunch(
  result: AgentTabLaunchOutcome
): Promise<StructuredAgentLaunchSettlement> {
  if (!result || 'refused' in result) {
    return { kind: 'cancelled', sessionId: null }
  }
  if (result.structuredSettlement) {
    return result.structuredSettlement
  }
  if (!(await terminalLaunchOpened({ opened: true, completion: result.terminalCompletion }))) {
    return { kind: 'cancelled', sessionId: null }
  }
  return { kind: 'terminal' }
}

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
        replan: () =>
          planAgentSessionLaunch(agentTabLaunchStore(useAppStore.getState(), args), {
            requestId,
            ...request
          })
      }
    : { plan: planAgentSessionLaunch(store, { requestId, ...request }) }
}

/** Open only after host facts settle or time out so startup loading cannot spuriously force the first launch into a terminal. */
export function launchOnceHostAnswered(
  route: AwaitingHostAnswer,
  args: LaunchAgentInNewTabArgs,
  relaunch: (args: LaunchAgentInNewTabArgs) => AgentTabLaunchOutcome,
  onFailure?: () => void
): LaunchAgentInNewTabResult {
  const opened = route.awaited.then(() =>
    relaunch({
      ...args,
      requestId: undefined,
      agentSessionLaunchPlan: route.replan()
    })
  )
  const structuredSettlement = opened
    .then(settleAgentTabLaunch)
    .catch((error: unknown): StructuredAgentLaunchSettlement => {
      args.focusIntent?.cancel()
      onFailure?.()
      return { kind: 'failed', error, ...(onFailure ? { notified: true as const } : {}) }
    })
  const deliversPrompt = Boolean(args.prompt?.trim())
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

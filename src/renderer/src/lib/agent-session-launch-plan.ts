import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  buildAgentLaunchRouteInput,
  type AgentLaunchRouteArgs,
  type AgentLaunchRouteStore
} from '@/lib/agent-launch-route-input'
import {
  resolveAgentLaunchRoute,
  structuredAgentLaunchSupported,
  type AgentLaunchRoute,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-initial-view-mode'
import {
  settleStructuredAgentLaunch,
  type StructuredAgentLaunchHooks,
  type StructuredAgentLaunchSettlement
} from '@/lib/structured-agent-launch-settlement'
import type { StructuredAgentLaunchOptions } from '@/lib/structured-agent-session-launch'

export type AgentSessionLaunchRequest = AgentLaunchRouteArgs & {
  /** Require structured native chat instead of applying the user's default route. */
  routeIntent?: 'structured-native-chat'
  resumeFrom?: StructuredAgentSessionResumeSource
  onPromptDelivered?: () => void
  notifyFailure?: boolean
  reconcileUnknownLaunch?: boolean
}

/**
 * A route decided once plus exactly what its structured launch delivers. The quick-create request
 * carries the data fields in renderer memory, so a launch that happens after the workspace exists
 * (or a retry within the same session) re-enters here without re-resolving.
 */
export type AgentSessionLaunchVerdict = {
  route: AgentLaunchRoute
  agent: TuiAgent
  worktreeId?: string
  prompt?: string
  promptDelivery?: NativeChatLaunchPromptDelivery
  resumeFrom?: StructuredAgentSessionResumeSource
  onPromptDelivered?: () => void
  notifyFailure?: boolean
  reconcileUnknownLaunch?: boolean
}

export type AgentSessionStructuredFeasibilityRequest = AgentLaunchRouteArgs & {
  /** Named explicitly rather than read off the store, so a React caller's memo depends on the
   *  settings this answer actually turns on. */
  settings: AgentLaunchRoutingInput['settings']
}

export type AgentSessionLaunchTarget = {
  /** Overrides the verdict's workspace when it was created after planning. */
  worktreeId?: string
}

export type AgentSessionLaunchPlan = Readonly<AgentSessionLaunchVerdict> & {
  /** Runs the structured settle loop for this plan. Null when the route is not structured. */
  launch(
    hooks: StructuredAgentLaunchHooks,
    target?: AgentSessionLaunchTarget
  ): Promise<StructuredAgentLaunchSettlement | null>
}

function structuredLaunchOptions(verdict: AgentSessionLaunchVerdict): StructuredAgentLaunchOptions {
  return {
    ...(verdict.prompt !== undefined ? { prompt: verdict.prompt } : {}),
    ...(verdict.promptDelivery ? { promptDelivery: verdict.promptDelivery } : {}),
    ...(verdict.resumeFrom ? { resumeFrom: verdict.resumeFrom } : {}),
    ...(verdict.onPromptDelivered ? { onPromptDelivered: verdict.onPromptDelivered } : {}),
    ...(verdict.notifyFailure !== undefined ? { notifyFailure: verdict.notifyFailure } : {}),
    ...(verdict.reconcileUnknownLaunch !== undefined
      ? { reconcileUnknownLaunch: verdict.reconcileUnknownLaunch }
      : {})
  }
}

/** Re-enter with a verdict decided earlier; the route is data here and is never re-resolved. */
export function adoptAgentSessionLaunchVerdict(
  verdict: AgentSessionLaunchVerdict
): AgentSessionLaunchPlan {
  return {
    ...verdict,
    launch: async (hooks, target) => {
      if (
        verdict.route !== 'structured-native-chat' ||
        !isAgentSessionHandleProvider(verdict.agent)
      ) {
        return null
      }
      const worktreeId = target?.worktreeId ?? verdict.worktreeId
      if (!worktreeId) {
        throw new Error('A structured agent launch needs the workspace it targets.')
      }
      return settleStructuredAgentLaunch(
        worktreeId,
        verdict.agent,
        structuredLaunchOptions(verdict),
        hooks
      )
    }
  }
}

/**
 * Can this pair open a structured session at all? A feasibility QUERY for enable/disable UI, not a
 * launch decision: it resolves no route and builds no plan, so a list may ask it per row.
 */
export function structuredAgentSessionLaunchFeasible(
  store: AgentLaunchRouteStore,
  request: AgentSessionStructuredFeasibilityRequest
): boolean {
  const { settings, ...args } = request
  // Why: the narrow settings ride on the built input, not the store, so a caller names the exact
  // settings this answer turns on without having to hold a whole store-shaped object.
  // The builder still reads launch customization off `store.settings`: safe only because the caller
  // names the object the store already holds — a different one would split this answer's sources.
  return structuredAgentLaunchSupported({ ...buildAgentLaunchRouteInput(store, args), settings })
}

/** The one place a launch route is decided. Delivery mode is fixed here too, so the settle loop
 *  later receives exactly the prompt and mode the route was decided on. */
export function planAgentSessionLaunch(
  store: AgentLaunchRouteStore,
  request: AgentSessionLaunchRequest
): AgentSessionLaunchPlan {
  return adoptAgentSessionLaunchVerdict({
    route:
      request.routeIntent ?? resolveAgentLaunchRoute(buildAgentLaunchRouteInput(store, request)),
    agent: request.agent,
    ...(request.workspace.worktreeId ? { worktreeId: request.workspace.worktreeId } : {}),
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.promptDelivery ? { promptDelivery: request.promptDelivery } : {}),
    ...(request.resumeFrom ? { resumeFrom: request.resumeFrom } : {}),
    ...(request.onPromptDelivered ? { onPromptDelivered: request.onPromptDelivered } : {}),
    ...(request.notifyFailure !== undefined ? { notifyFailure: request.notifyFailure } : {}),
    ...(request.reconcileUnknownLaunch !== undefined
      ? { reconcileUnknownLaunch: request.reconcileUnknownLaunch }
      : {})
  })
}

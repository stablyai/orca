import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { TuiAgent } from '../../../shared/tui-agent'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { StructuredAgentSessionOwnerUnresolvedError } from '@/lib/launch-structured-agent-session'
import {
  buildAgentLaunchRouteInput,
  type AgentLaunchRouteArgs,
  type AgentLaunchRouteStore
} from '@/lib/agent-launch-route-input'
import {
  resolveAgentLaunchRoute,
  structuredAgentLaunchDowngrade,
  structuredAgentLaunchSupported,
  type AgentLaunchRoute,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-launch-prompt-delivery'
import {
  beginStructuredAgentLaunchSettlement,
  type StructuredAgentLaunchHandle,
  type StructuredAgentLaunchHooks,
  type StructuredAgentLaunchSettlement
} from '@/lib/structured-agent-launch-settlement'
import type { StructuredAgentLaunchOptions } from '@/lib/structured-agent-session-launch'
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { relearnHostStructuredAgents } from '@/runtime/host-structured-agents'
import { awaitLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'

export type AgentSessionLaunchRequest = AgentLaunchRouteArgs & {
  /** The user action this launch serves, minted where that action is handled. */
  requestId: AgentLaunchRequestId
  resumeFrom?: StructuredAgentSessionResumeSource
  onPromptDelivered?: () => void
  /** The caller keeps the prompt's text if it does not go out (notes), so no composer gets it. */
  promptKeptByCaller?: true
}

/**
 * A route decided once plus exactly what its structured launch delivers. The quick-create request
 * carries the data fields in renderer memory, so a launch that happens after the workspace exists
 * (or a retry within the same session) re-enters here without re-resolving.
 */
export type AgentSessionLaunchVerdict = {
  route: AgentLaunchRoute
  /** The user action this launch serves; a re-entry with this verdict is that same action. */
  requestId: AgentLaunchRequestId
  agent: TuiAgent
  worktreeId?: string
  /** The host the structured route was decided for; the chat is created there. */
  executionHostId?: ExecutionHostId
  prompt?: string
  promptDelivery?: NativeChatLaunchPromptDelivery
  resumeFrom?: StructuredAgentSessionResumeSource
  onPromptDelivered?: () => void
  promptKeptByCaller?: true
}

export type AgentSessionStructuredFeasibilityRequest = AgentLaunchRouteArgs & {
  /** Named explicitly rather than read off the store, so a React caller's memo depends on the
   *  settings this answer actually turns on. */
  settings: AgentLaunchRoutingInput['settings']
}

export type AgentSessionLaunchTarget = {
  /** Overrides the verdict's workspace when it was created after planning. */
  worktreeId?: string
  /** The host that admitted the chat, when one was asked first; it is the host the chat is made on. */
  executionHostId?: ExecutionHostId
  /** The saved selection that host said create will seed. */
  seedOptions?: Readonly<Record<string, string>>
  /** The tab group the chat opens in. */
  groupId?: string
}

export type AgentSessionLaunchPlan = Readonly<AgentSessionLaunchVerdict> & {
  /** Begins the launch and exposes its durable identity before host acquisition settles. */
  begin(
    hooks: StructuredAgentLaunchHooks,
    target?: AgentSessionLaunchTarget
  ): StructuredAgentLaunchHandle | null
  /** Runs the structured settle loop for this plan. Null when the route is not structured. */
  launch(
    hooks: StructuredAgentLaunchHooks,
    target?: AgentSessionLaunchTarget
  ): Promise<StructuredAgentLaunchSettlement | null>
}

function structuredLaunchOptions(verdict: AgentSessionLaunchVerdict): StructuredAgentLaunchOptions {
  return {
    requestId: verdict.requestId,
    ...(verdict.prompt !== undefined ? { prompt: verdict.prompt } : {}),
    ...(verdict.promptDelivery ? { promptDelivery: verdict.promptDelivery } : {}),
    ...(verdict.resumeFrom ? { resumeFrom: verdict.resumeFrom } : {}),
    ...(verdict.onPromptDelivered ? { onPromptDelivered: verdict.onPromptDelivered } : {}),
    ...(verdict.promptKeptByCaller ? { promptKeptByCaller: true as const } : {}),
    ...(verdict.executionHostId ? { executionHostId: verdict.executionHostId } : {})
  }
}

function beginStructuredPlanLaunch(
  verdict: AgentSessionLaunchVerdict,
  hooks: StructuredAgentLaunchHooks,
  target?: AgentSessionLaunchTarget
): StructuredAgentLaunchHandle | null {
  // The route already admitted the agent: its host registered it as structured.
  if (verdict.route !== 'structured-native-chat') {
    return null
  }
  const worktreeId = target?.worktreeId ?? verdict.worktreeId
  if (!worktreeId) {
    throw new Error('A structured agent launch needs the workspace it targets.')
  }
  const executionHostId = target?.executionHostId ?? verdict.executionHostId
  try {
    return beginStructuredAgentLaunchSettlement(
      worktreeId,
      verdict.agent,
      {
        ...structuredLaunchOptions(verdict),
        ...(executionHostId ? { executionHostId } : {}),
        ...(target?.seedOptions ? { hostSeedOptions: target.seedOptions } : {}),
        ...(target?.groupId ? { targetGroupId: target.groupId } : {})
      },
      hooks
    )
  } catch (error) {
    if (!(error instanceof StructuredAgentSessionOwnerUnresolvedError)) {
      throw error
    }
    console.warn('[native-chat] structured launch refused', error)
    toast.error(
      translate(
        'auto.store.slices.workspace.cleanup.hostUnresolved',
        'Orca cannot tell which host owns this workspace. Refresh projects and review it again.'
      )
    )
    return null
  }
}

/** Re-enter with a verdict decided earlier; the route is data here and is never re-resolved. */
export function adoptAgentSessionLaunchVerdict(
  verdict: AgentSessionLaunchVerdict
): AgentSessionLaunchPlan {
  return {
    ...verdict,
    begin: (hooks, target) => beginStructuredPlanLaunch(verdict, hooks, target),
    launch: async (hooks, target) =>
      beginStructuredPlanLaunch(verdict, hooks, target)?.settlement ?? null
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
  return structuredAgentLaunchSupported({ ...buildAgentLaunchRouteInput(store, args), settings })
}

/** The route a launch would take, for a caller that only branches on it and launches nothing. */
export function resolveAgentSessionLaunchRoute(
  store: AgentLaunchRouteStore,
  request: AgentLaunchRouteArgs
): AgentLaunchRoute {
  return resolveAgentLaunchRoute(buildAgentLaunchRouteInput(store, request))
}

/** Says in the console why a launch with structured chat on opens a terminal, and asks again a
 *  host whose agent list was never learned, so the next launch can open its chat. */
function reportStructuredLaunchDowngrade(
  store: AgentLaunchRouteStore,
  input: AgentLaunchRoutingInput,
  route: AgentLaunchRoute
): void {
  const downgrade = structuredAgentLaunchDowngrade(input, route)
  if (!downgrade) {
    return
  }
  console.warn(
    `[agent-launch-route] ${input.agent} opens ${route}: ${downgrade} (host ${input.executionHostId}, ` +
      `host agents ${input.hostStructuredAgents ? 'listed' : 'not learned'}, ` +
      `host capabilities ${input.hostCapabilities ? 'known' : 'unknown'})`
  )
  if (downgrade === 'agent-without-structured-session' && !input.hostStructuredAgents) {
    // Bookkeeping: a failed re-ask never touches this launch.
    relearnHostStructuredAgents(
      input.executionHostId,
      input.hostCapabilities,
      store.runtimeStatusByEnvironmentId
    ).catch((error: unknown) => {
      console.warn('[agent-launch-route] could not ask the host for its agents again', error)
    })
  }
}

/** What a launch's chat route is waiting to hear from its host, if anything: the host's agent
 *  list, or this computer's runtime capabilities while startup is still answering. */
function structuredRouteAwaits(
  input: AgentLaunchRoutingInput
): 'host-agents' | 'local-capabilities' | null {
  const downgrade = structuredAgentLaunchDowngrade(input, resolveAgentLaunchRoute(input))
  if (
    downgrade === 'agent-without-structured-session' &&
    !input.hostStructuredAgents &&
    // A host that does not publish its agents has no list to wait for.
    input.hostCapabilities?.includes(
      STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
    ) !== false
  ) {
    return 'host-agents'
  }
  return downgrade === 'runtime-capability-unknown' &&
    parseExecutionHostId(input.executionHostId)?.kind === 'local'
    ? 'local-capabilities'
    : null
}

/** When a launch's chat route waits only on its host's answer (the agent list, or this
 *  computer's runtime capabilities during a slow startup), asks for it and resolves once it came
 *  or after `waitMs`, whichever is first; null when the route waits on neither. The caller then
 *  decides the route again. */
export function awaitStructuredRouteHostAnswer(
  store: AgentLaunchRouteStore,
  request: AgentLaunchRouteArgs,
  waitMs: number
): Promise<void> | null {
  const input = buildAgentLaunchRouteInput(store, request)
  const awaits = structuredRouteAwaits(input)
  if (!awaits) {
    return null
  }
  let stopCapabilitiesWait = (): void => {}
  const ask = async (): Promise<void> => {
    let capabilities = input.hostCapabilities
    // Either route may be missing this computer's capabilities: wait for the probe that lands
    // them, since one that failed at startup answers null at once.
    if (capabilities === null && parseExecutionHostId(input.executionHostId)?.kind === 'local') {
      const wait = awaitLocalRuntimeCapabilities()
      stopCapabilitiesWait = wait.stop
      capabilities = await wait.known
    }
    await relearnHostStructuredAgents(
      input.executionHostId,
      capabilities,
      store.runtimeStatusByEnvironmentId
    )
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const answered = ask().catch((error: unknown) => {
    console.warn('[agent-launch-route] could not ask the host', error)
  })
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs)
  })
  return Promise.race([answered, deadline]).finally(() => {
    clearTimeout(timer)
    stopCapabilitiesWait()
  })
}

/** The one place a launch route is decided. Delivery mode is fixed here too, so the settle loop
 *  later receives exactly the prompt and mode the route was decided on. */
export function planAgentSessionLaunch(
  store: AgentLaunchRouteStore,
  request: AgentSessionLaunchRequest
): AgentSessionLaunchPlan {
  const input = buildAgentLaunchRouteInput(store, request)
  const route = resolveAgentLaunchRoute(input)
  reportStructuredLaunchDowngrade(store, input, route)
  const executionHostId =
    route === 'structured-native-chat' ? parseExecutionHostId(input.executionHostId)?.id : undefined
  return adoptAgentSessionLaunchVerdict({
    route,
    requestId: request.requestId,
    agent: request.agent,
    ...(executionHostId ? { executionHostId } : {}),
    ...(request.workspace.worktreeId ? { worktreeId: request.workspace.worktreeId } : {}),
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.promptDelivery ? { promptDelivery: request.promptDelivery } : {}),
    ...(request.resumeFrom ? { resumeFrom: request.resumeFrom } : {}),
    ...(request.onPromptDelivered ? { onPromptDelivered: request.onPromptDelivered } : {}),
    ...(request.promptKeptByCaller ? { promptKeptByCaller: true as const } : {})
  })
}

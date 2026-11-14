import {
  notifyAgentLaunchFailure,
  agentLaunchRecoveryMessage
} from '@/lib/agent-session/launch/failure/agent-launch-failure'
import { isLocalExecutionHost, parseExecutionHostId } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import '../structured-agent-session-launch-intent'
import { StructuredAgentSessionOwnerUnresolvedError } from '../structured-agent-session-launch-errors'
import { buildAgentLaunchRouteInput } from './agent-launch-route-input'
import type { AgentLaunchRouteArgs, AgentLaunchRouteStore } from './agent-launch-route-input'
import {
  resolveAgentLaunchRoute,
  structuredAgentLaunchDowngrade,
  structuredAgentLaunchSupported
} from './agent-launch-routing'
import type { AgentLaunchRoute, AgentLaunchRoutingInput } from './agent-launch-routing'
import { beginStructuredAgentLaunchSettlement } from '../continuation/structured-agent-launch-settlement'
import type {
  StructuredAgentLaunchHandle,
  StructuredAgentLaunchHooks,
  StructuredAgentLaunchSettlement
} from '../continuation/structured-agent-launch-settlement'
import { relearnHostStructuredAgents } from '../../../../runtime/native-chat/agent-catalogs/host-structured-agents'
import { awaitLocalRuntimeCapabilities } from '../../../../runtime/hosts/capabilities/local-runtime-capabilities'
import type { StructuredLaunchSurfaceAddress } from '../structured-agent-session-launch-record'
import type {
  StructuredAgentSessionForkSource,
  StructuredAgentSessionResumeSource
} from '../../../../../../shared/agent-session/structured-agent-session-create'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  launchPinsClaudeAccount,
  resolvePlannedRoute,
  type ClaudeAccountRouteArgs
} from '@/lib/agent-session-launch-claude-account'
import type { NativeChatLaunchPromptDelivery } from '../prompt/native-chat-launch-prompt-delivery'
import type { StructuredAgentLaunchOptions } from '../structured-agent-session-launch-callers'

export type AgentLaunchSurface = 'chat' | 'terminal'

export type AgentSessionLaunchRequest = ClaudeAccountRouteArgs & {
  requestId: string
  requestedSurface?: AgentLaunchSurface
  selectedExecutionHostId?: ExecutionHostId
  resumeFrom?: StructuredAgentSessionResumeSource
  forkFrom?: StructuredAgentSessionForkSource
  onPromptDelivered?: () => void
  /** The caller keeps the prompt's text if it does not go out (notes), so no composer gets it. */
  promptKeptByCaller?: true
  /** Options this launch asks for over the saved chat defaults, e.g. an action's model. */
  launchOptions?: Readonly<Record<string, string>>
  chatLaunchOptions?: Readonly<Record<string, string>>
}

/** Carry the decided route and delivery fields in memory so post-create launches and same-session retries reuse them without re-resolving. */
export type AgentSessionLaunchVerdict = Pick<
  StructuredAgentLaunchOptions,
  'promptAttachments' | 'promptSkills' | 'preparePrompt'
> & {
  route: AgentLaunchRoute
  requestedSurface?: AgentLaunchSurface
  requestId: string
  agent: TuiAgent
  worktreeId?: string
  executionHostId?: ExecutionHostId
  prompt?: string
  promptDelivery?: NativeChatLaunchPromptDelivery
  resumeFrom?: StructuredAgentSessionResumeSource
  forkFrom?: StructuredAgentSessionForkSource
  onPromptDelivered?: () => void
  promptKeptByCaller?: true
  draftFromScope?: string
  launchOptions?: Readonly<Record<string, string>>
  chatLaunchOptions?: Readonly<Record<string, string>>
}

export type AgentSessionStructuredFeasibilityRequest = AgentLaunchRouteArgs & {
  /** Name settings explicitly so React memo dependencies match the values this decision reads. */
  settings: AgentLaunchRoutingInput['settings']
}

export type AgentSessionLaunchTarget = {
  surfaceAddress?: StructuredLaunchSurfaceAddress
  /** Overrides the verdict's workspace when it was created after planning. */
  worktreeId?: string
  /** The host that admitted the chat, when one was asked first; it is the host the chat is made on. */
  executionHostId?: ExecutionHostId
  /** The saved selection that host said create will seed. */
  seedOptions?: Readonly<Record<string, string>>
}

export type AgentSessionLaunchPlan = Readonly<AgentSessionLaunchVerdict> & {
  begin(
    hooks: StructuredAgentLaunchHooks,
    target?: AgentSessionLaunchTarget
  ): StructuredAgentLaunchHandle | null
  launch(
    hooks: StructuredAgentLaunchHooks,
    target?: AgentSessionLaunchTarget
  ): Promise<StructuredAgentLaunchSettlement | null>
}

function structuredLaunchOptions(verdict: AgentSessionLaunchVerdict): StructuredAgentLaunchOptions {
  return {
    requestId: verdict.requestId,
    ...(verdict.prompt !== undefined ? { prompt: verdict.prompt } : {}),
    ...(verdict.promptAttachments?.length ? { promptAttachments: verdict.promptAttachments } : {}),
    ...(verdict.promptSkills?.length ? { promptSkills: verdict.promptSkills } : {}),
    ...(verdict.preparePrompt ? { preparePrompt: verdict.preparePrompt } : {}),
    ...(verdict.promptDelivery ? { promptDelivery: verdict.promptDelivery } : {}),
    ...(verdict.resumeFrom ? { resumeFrom: verdict.resumeFrom } : {}),
    ...(verdict.forkFrom ? { forkFrom: verdict.forkFrom } : {}),
    ...(verdict.onPromptDelivered ? { onPromptDelivered: verdict.onPromptDelivered } : {}),
    ...(verdict.promptKeptByCaller ? { promptKeptByCaller: true as const } : {}),
    ...(verdict.draftFromScope ? { draftFromScope: verdict.draftFromScope } : {}),
    ...(verdict.executionHostId ? { executionHostId: verdict.executionHostId } : {}),
    ...(verdict.chatLaunchOptions !== undefined || verdict.launchOptions !== undefined
      ? { launchOptions: verdict.chatLaunchOptions ?? verdict.launchOptions }
      : {})
  }
}

function beginStructuredPlanLaunch(
  verdict: AgentSessionLaunchVerdict,
  hooks: StructuredAgentLaunchHooks,
  target?: AgentSessionLaunchTarget
): StructuredAgentLaunchHandle | null {
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
        ...(target?.surfaceAddress ? { surfaceAddress: target.surfaceAddress } : {}),
        ...(executionHostId ? { executionHostId } : {}),
        ...(target?.seedOptions ? { hostSeedOptions: target.seedOptions } : {})
      },
      hooks
    )
  } catch (error) {
    if (!(error instanceof StructuredAgentSessionOwnerUnresolvedError)) {
      throw error
    }
    console.warn('[native-chat] structured launch refused', error)
    notifyAgentLaunchFailure(verdict.agent, agentLaunchRecoveryMessage('refreshProjects'))
    return null
  }
}

export function adoptAgentSessionLaunchVerdict(
  verdict: AgentSessionLaunchVerdict
): AgentSessionLaunchPlan {
  verdict = {
    ...verdict,
    ...(verdict.launchOptions !== undefined ? { launchOptions: { ...verdict.launchOptions } } : {}),
    ...(verdict.chatLaunchOptions !== undefined
      ? { chatLaunchOptions: { ...verdict.chatLaunchOptions } }
      : {})
  }
  return {
    ...verdict,
    begin: (hooks, target) => beginStructuredPlanLaunch(verdict, hooks, target),
    launch: async (hooks, target) =>
      beginStructuredPlanLaunch(verdict, hooks, target)?.settlement ?? null
  }
}

/** Query structured feasibility for row enablement only; do not decide a route or build a launch plan. */
export function structuredAgentSessionLaunchFeasible(
  store: AgentLaunchRouteStore,
  request: AgentSessionStructuredFeasibilityRequest
): boolean {
  const { settings, ...args } = request
  // Carry narrow settings on the built input so callers can name exact dependencies without a whole store object.
  return structuredAgentLaunchSupported({ ...buildAgentLaunchRouteInput(store, args), settings })
}

export function resolveAgentSessionLaunchRoute(
  store: AgentLaunchRouteStore,
  request: ClaudeAccountRouteArgs & Pick<AgentSessionLaunchRequest, 'requestedSurface'>
): AgentLaunchRoute {
  return resolvePlannedRoute(store, request, buildAgentLaunchRouteInput(store, request))
}

/** Log chat-to-terminal fallback and re-ask missing host agent lists for future launches. */
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

/** Identify pending host-agent inventory or local startup capabilities that a chat route still needs. */
function structuredRouteAwaits(
  input: AgentLaunchRoutingInput
): 'host-agents' | 'local-capabilities' | null {
  const downgrade = structuredAgentLaunchDowngrade(input, resolveAgentLaunchRoute(input))
  if (
    downgrade === 'agent-without-structured-session' &&
    !input.hostStructuredAgents &&
    input.hostCapabilities?.includes(
      STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
    ) !== false
  ) {
    return 'host-agents'
  }
  return downgrade === 'runtime-capability-unknown' && isLocalExecutionHost(input.executionHostId)
    ? 'local-capabilities'
    : null
}

/** Await missing host-agent inventory or local startup capabilities up to waitMs, then let the caller resolve again; null when neither is pending. */
export function awaitStructuredRouteHostAnswer(
  store: AgentLaunchRouteStore,
  request: ClaudeAccountRouteArgs,
  waitMs: number
): Promise<void> | null {
  // Why: a pinned Claude launch is a terminal whatever the host answers, so it never waits.
  if (launchPinsClaudeAccount(store, request)) {
    return null
  }
  const input = buildAgentLaunchRouteInput(store, request)
  if (!structuredRouteAwaits(input)) {
    return null
  }
  let stopCapabilitiesWait = (): void => {}
  const timedOut = Symbol('host-answer-timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut), waitMs)
  })
  const ask = async (): Promise<void> => {
    let capabilities = input.hostCapabilities
    // Await the probe itself: startup failure can leave capabilities null without another pending answer.
    if (capabilities === null && isLocalExecutionHost(input.executionHostId)) {
      const wait = awaitLocalRuntimeCapabilities()
      stopCapabilitiesWait = wait.stop
      capabilities = await Promise.race([wait.known, deadline])
    }
    await Promise.race([
      relearnHostStructuredAgents(
        input.executionHostId,
        capabilities,
        store.runtimeStatusByEnvironmentId
      ),
      deadline
    ])
  }
  const answered = ask().catch((error: unknown) => {
    if (error !== timedOut) {
      console.warn('[agent-launch-route] could not ask the host', error)
    }
  })
  return answered.finally(() => {
    clearTimeout(timer)
    stopCapabilitiesWait()
  })
}

/** Decide route and delivery mode together so settlement receives the exact prompt/mode the route admitted. */
export function planAgentSessionLaunch(
  store: AgentLaunchRouteStore,
  request: AgentSessionLaunchRequest
): AgentSessionLaunchPlan {
  const input = buildAgentLaunchRouteInput(store, request)
  const route = resolvePlannedRoute(store, request, input)
  if (!request.requestedSurface) {
    reportStructuredLaunchDowngrade(store, input, route)
  }
  const executionHostId =
    route === 'structured-native-chat'
      ? (request.selectedExecutionHostId ?? parseExecutionHostId(input.executionHostId)?.id)
      : undefined
  return adoptAgentSessionLaunchVerdict({
    route,
    ...(request.requestedSurface ? { requestedSurface: request.requestedSurface } : {}),
    requestId: request.requestId,
    agent: request.agent,
    ...(executionHostId ? { executionHostId } : {}),
    ...(request.workspace.worktreeId ? { worktreeId: request.workspace.worktreeId } : {}),
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.promptDelivery ? { promptDelivery: request.promptDelivery } : {}),
    ...(request.resumeFrom ? { resumeFrom: request.resumeFrom } : {}),
    ...(request.forkFrom ? { forkFrom: request.forkFrom } : {}),
    ...(request.onPromptDelivered ? { onPromptDelivered: request.onPromptDelivered } : {}),
    ...(request.promptKeptByCaller ? { promptKeptByCaller: true as const } : {}),
    ...(request.launchOptions ? { launchOptions: request.launchOptions } : {}),
    ...(request.chatLaunchOptions !== undefined
      ? { chatLaunchOptions: request.chatLaunchOptions }
      : {})
  })
}

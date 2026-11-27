import { nativeChatPreferenceFor } from '../../../../../../shared/agent-launch/choices/structured-native-chat-launch-route'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { registeredAgentChatInstallable } from '../../../../../../shared/agent-session/agent-discovery/agent-session-registered-agents'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY
} from '../../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentSessionChatProgram } from '../../../../../../shared/agent-session/agent-discovery/agent-session-agent-availability'
import { chatProviderAgents } from '../../../../runtime/native-chat/agent-catalogs/chat-provider-agents'
import {
  resolveAgentLaunchRoute,
  structuredAgentLaunchSupport
} from '../routing/agent-launch-routing'
import {
  buildAgentLaunchRouteInput,
  resolveAgentLaunchHost,
  routeHostStatuses,
  type AgentLaunchRouteStore,
  type ProspectiveWorkspace
} from '../routing/agent-launch-route-input'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-subscriptions'
import {
  readHostStructuredAgentAvailability,
  subscribeHostStructuredAgentAvailability
} from '@/runtime/native-chat/agent-catalogs/host-structured-agent-availability'
import {
  hostStructuredAgentsReadFailed,
  readHostStructuredAgentsForRuntime,
  subscribeHostStructuredAgents
} from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { subscribeLocalRuntimeCapabilityObservation } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { getResolvedExecutionHostIdForWorktree } from '../../../workspace/ownership/resolved-worktree-execution-host'

export type ChatProgramObservation = AgentSessionChatProgram | 'unlearned'

function hostContext(
  statuses: RuntimeStatuses,
  host: { executionHostId: string; hostCapabilities: readonly string[] | null }
) {
  const parsed = parseExecutionHostId(host.executionHostId)
  const environmentId = parsed?.kind === 'runtime' ? parsed.environmentId : undefined
  const entry = environmentId ? statuses.get(environmentId) : undefined
  const runtimeId = parsed?.kind === 'local' ? null : lastVerifiedRuntimeStatus(entry)?.runtimeId
  const pairingRevision = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  const identity = JSON.stringify([host.executionHostId, runtimeId, pairingRevision])
  return {
    ...host,
    environmentId,
    runtimeId,
    pairingRevision,
    target: structuredAgentSessionTargetForHost(host.executionHostId),
    revision: JSON.stringify([
      identity,
      host.hostCapabilities,
      entry?.connectionGeneration,
      entry?.hostContactEpoch
    ])
  }
}

/** Ownership is resolved before agent policy; an unresolved workspace never acquires locally. */
export function resolveChatProgramContext(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace
) {
  const { owner, ...host } = resolveAgentLaunchHost(store, workspace)
  const proven = workspace.worktreeId
    ? getResolvedExecutionHostIdForWorktree(store, workspace.worktreeId)
    : null
  return hostContext(
    routeHostStatuses(store),
    owner === null ? { ...host, executionHostId: proven?.startsWith('ssh:') ? proven : '' } : host
  )
}

/** Only absent publication uses older-host inference; present unknown wins. */
export function readChatProgram(
  statuses: RuntimeStatuses,
  agent: TuiAgent,
  host: { executionHostId: string; hostCapabilities: readonly string[] | null },
  detected: readonly TuiAgent[] | null
): ChatProgramObservation {
  const context = hostContext(statuses, host)
  const { executionHostId, runtimeId, pairingRevision, hostCapabilities: capabilities } = context
  const snapshot = readHostStructuredAgentAvailability(executionHostId, runtimeId, pairingRevision)
  const published = snapshot.state === 'received' ? snapshot.byAgent.get(agent) : undefined
  // A publishing host's roster answers; an older host's absent field falls to inference below.
  if (published?.chatProgram || (capabilities?.includes(AVAILABILITY) && !published)) {
    return (
      published?.chatProgram ??
      (snapshot.state === 'received'
        ? 'missing'
        : snapshot.state === 'pending'
          ? 'unlearned'
          : 'unknown')
    )
  }
  const catalog = readHostStructuredAgentsForRuntime(executionHostId, runtimeId)
  return capabilities === null || runtimeId === undefined
    ? 'unlearned'
    : detected?.includes(agent)
      ? 'available'
      : registeredAgentChatInstallable(catalog, agent, capabilities)
        ? 'installable'
        : !catalog && capabilities.includes(CATALOG)
          ? hostStructuredAgentsReadFailed(executionHostId, runtimeId)
            ? 'unknown'
            : 'unlearned'
          : detected === null
            ? 'unknown'
            : 'missing'
}

export function chatProgramOffered(program: ChatProgramObservation): boolean {
  return program === 'available' || program === 'installable'
}

/** Published program truth and permission to preserve an explicit launch are separate. */
export function readAgentLaunchChoice(
  store: AgentLaunchRouteStore,
  agent: TuiAgent,
  workspace: ProspectiveWorkspace,
  detected: readonly TuiAgent[] | null,
  preferredSurface?: 'chat'
) {
  const context = resolveChatProgramContext(store, workspace)
  const input = buildAgentLaunchRouteInput(store, { agent, workspace, preferredSurface })
  const program = readChatProgram(routeHostStatuses(store), agent, context, detected)
  const support = structuredAgentLaunchSupport(input)
  const catalogReady =
    context.hostCapabilities !== null &&
    (!context.hostCapabilities.includes(CATALOG) ||
      readHostStructuredAgentsForRuntime(context.executionHostId, context.runtimeId) !== undefined)
  const unresolved =
    !context.target || program === 'unknown' || program === 'unlearned' || !catalogReady
  const routePending =
    !support.supported &&
    (support.blocker === 'runtime-capability-unknown' ||
      (support.blocker === 'agent-without-structured-session' && !catalogReady))
  const chatEligibility =
    (preferredSurface !== 'chat' && !nativeChatPreferenceFor(store.settings, agent)) ||
    (!support.supported && !routePending) ||
    program === 'missing'
      ? 'no'
      : resolveAgentLaunchRoute(input) === 'structured-native-chat' &&
          (chatProgramOffered(program) || detected?.includes(agent))
        ? 'opens'
        : unresolved
          ? 'unresolved'
          : 'no'
  return { program, chatEligibility, catalogReady }
}

type ChoiceArgs = Parameters<typeof readAgentLaunchChoice>
export const agentChoiceOpensAsChat = (...args: ChoiceArgs): boolean =>
  readAgentLaunchChoice(...args).chatEligibility === 'opens'
export const agentChoicePending = (...args: ChoiceArgs): boolean =>
  readAgentLaunchChoice(...args).chatEligibility === 'unresolved'
export const agentChoiceMayOpenAsChat = (...args: ChoiceArgs): boolean =>
  readAgentLaunchChoice(...args).chatEligibility !== 'no'
export function chosenAgentChatUnlearned(
  store: AgentLaunchRouteStore,
  chosen: TuiAgent | 'blank' | null | undefined,
  detected: readonly TuiAgent[] | null,
  workspace: ProspectiveWorkspace
): boolean {
  return !!chosen && chosen !== 'blank' && agentChoicePending(store, chosen, workspace, detected)
}

/** Offers may include setup-capable chats; automatic candidates remain the original inventory. */
export function agentsOfferedForLaunch(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace,
  detected: readonly TuiAgent[] | null,
  preferredChatAgent?: TuiAgent
): TuiAgent[] {
  const { executionHostId } = resolveChatProgramContext(store, workspace)
  const chats = chatProviderAgents(executionHostId, routeHostStatuses(store))
  const opens = chats.filter((agent) =>
    agentChoiceOpensAsChat(
      store,
      agent,
      workspace,
      detected,
      agent === preferredChatAgent ? 'chat' : undefined
    )
  )
  return [...new Set([...(detected ?? []), ...opens])]
}

let factsVersion = 0
export const readChatProgramFactsVersion = (): number => factsVersion
export function subscribeChatProgramFacts(listener: () => void): () => void {
  const notify = (): void => {
    factsVersion += 1
    listener()
  }
  const releases = [
    subscribeHostStructuredAgentAvailability(notify),
    subscribeHostStructuredAgents(notify),
    subscribeLocalRuntimeCapabilityObservation(notify),
    onRuntimeEnvironmentRevisionsChanged(notify),
    onRuntimeEnvironmentsRetired(notify)
  ]
  return () => releases.forEach((release) => release())
}

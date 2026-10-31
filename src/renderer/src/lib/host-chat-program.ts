import { nativeChatPreferenceFor } from '../../../shared/structured-native-chat-launch-route'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY as INSTALL } from '../../../shared/managed-runtime-install'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY
} from '../../../shared/protocol-version'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentSessionChatProgram } from '../../../shared/agent-session-agent-availability'
import { chatProviderAgents } from './chat-provider-agents'
import { resolveAgentLaunchRoute, structuredAgentLaunchSupport } from './agent-launch-routing'
import {
  buildAgentLaunchRouteInput,
  resolveAgentLaunchHost,
  type AgentLaunchRouteStore,
  type ProspectiveWorkspace
} from './agent-launch-route-input'
import {
  readHostStructuredAgentAvailability,
  subscribeHostStructuredAgentAvailability
} from '@/runtime/host-structured-agent-availability'
import {
  hostStructuredAgentsReadFailed,
  readHostStructuredAgentsForRuntime,
  subscribeHostStructuredAgents
} from '@/runtime/host-structured-agents'
import { subscribeLocalRuntimeCapabilityObservation } from '@/runtime/local-runtime-capabilities'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'

export type ChatProgramObservation = AgentSessionChatProgram | 'unlearned'
type HostFactsStore = Pick<AgentLaunchRouteStore, 'runtimeStatusByEnvironmentId'>

function hostContext(
  store: HostFactsStore,
  host: { executionHostId: string; hostCapabilities: readonly string[] | null }
) {
  const parsed = parseExecutionHostId(host.executionHostId)
  const environmentId = parsed?.kind === 'runtime' ? parsed.environmentId : undefined
  const entry = environmentId ? store.runtimeStatusByEnvironmentId?.get(environmentId) : undefined
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
    store,
    owner === null ? { ...host, executionHostId: proven?.startsWith('ssh:') ? proven : '' } : host
  )
}

/** Only absent publication uses older-host inference; present unknown wins. */
export function readChatProgram(
  store: HostFactsStore,
  agent: TuiAgent,
  host: { executionHostId: string; hostCapabilities: readonly string[] | null },
  detected: readonly TuiAgent[] | null
): ChatProgramObservation {
  const context = hostContext(store, host)
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
      : catalog?.some((row) => row.agent === agent && row.managedRuntime) &&
          capabilities.includes(INSTALL)
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
  detected: readonly TuiAgent[] | null
) {
  const context = resolveChatProgramContext(store, workspace)
  const input = buildAgentLaunchRouteInput(store, { agent, workspace })
  const program = readChatProgram(store, agent, context, detected)
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
    !nativeChatPreferenceFor(store.settings, agent) ||
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
  detected: readonly TuiAgent[] | null
): TuiAgent[] {
  const { executionHostId } = resolveChatProgramContext(store, workspace)
  const chats = chatProviderAgents(executionHostId, store.runtimeStatusByEnvironmentId)
  const opens = chats.filter((agent) => agentChoiceOpensAsChat(store, agent, workspace, detected))
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

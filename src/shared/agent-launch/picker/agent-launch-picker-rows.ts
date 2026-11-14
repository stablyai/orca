import type { AgentPickerEntry } from './agent-launch-picker'
import type { GlobalSettings } from '../../global-settings-types'
import {
  nativeChatPreferenceFor,
  type NativeChatDefaultSettings
} from '../../structured-native-chat-launch-route'
import type { ExecutionHostId } from '../../execution-host'
import type { TuiAgent } from '../catalog/tui-agent'
import { filterEnabledTuiAgents, TUI_AGENT_AUTO_PICK_ORDER } from '../catalog/tui-agent-selection'
import type { AgentSessionChatProgram } from '../../agent-session/agent-session-agent-availability'
import { agentSessionInstallCommand } from '../../agent-session/lifecycle/launch/agent-session-setup-commands'

export type HostChatAnswer =
  | 'yes'
  | 'not-yet-known'
  | 'ssh'
  | 'wsl'
  | 'subfolder'
  | 'not-on-host'
  /** The host is Windows, where this agent has no chat. */
  | 'windows'
  | 'no-chats'
export type ChatProgramObservation = AgentSessionChatProgram | 'unlearned'
const chatProgramOffered = (program: ChatProgramObservation) =>
  program === 'available' || program === 'installable'

export function orderAgentLaunchPickerAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detected: readonly TuiAgent[],
  disabled?: Iterable<unknown> | null
): TuiAgent[] {
  const enabled = filterEnabledTuiAgents(detected, disabled)
  const ordered = TUI_AGENT_AUTO_PICK_ORDER.filter((agent) => enabled.includes(agent))
  return defaultAgent && defaultAgent !== 'blank' && ordered.includes(defaultAgent)
    ? [defaultAgent, ...ordered.filter((agent) => agent !== defaultAgent)]
    : ordered
}

export type ChatUnavailableReason =
  | 'check-failed'
  | 'not-installed'
  | 'ssh'
  | 'wsl'
  | 'subfolder'
  | 'not-on-host'
  | 'windows'

export type NewTabAgentMenuRow = (
  | { kind: 'chat'; agent: TuiAgent }
  | { kind: 'chat-unavailable'; agent: TuiAgent; reason: ChatUnavailableReason }
  | { kind: 'cli'; agent: TuiAgent; chat?: true }
  | { kind: 'terminal'; agent: TuiAgent }
) & { executionHostId?: ExecutionHostId }

export type NewTabAgentMenuSettings = NativeChatDefaultSettings &
  Partial<Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>>

export function buildNewTabAgentMenuRows(args: {
  settings: NewTabAgentMenuSettings | null | undefined
  detectedOnHost: readonly TuiAgent[] | null
  chatAgents: readonly TuiAgent[]
  hostChatAnswer: (agent: TuiAgent) => HostChatAnswer
  /** Whether the chat's own program runs there, which for some agents is not their CLI. */
  chatProgram: (agent: TuiAgent) => ChatProgramObservation
  /** Offer chats for agents the host lacks: the chat walks through installing and signing in. */
  offerAgentSetup?: boolean
  hostPlatform?: string | null
}): NewTabAgentMenuRow[] {
  const { settings } = args
  const defaultAgent = settings?.defaultTuiAgent
  const installed = filterEnabledTuiAgents(args.detectedOnHost ?? [], settings?.disabledTuiAgents)
  if (args.hostChatAnswer('claude') === 'no-chats') {
    return orderAgentLaunchPickerAgents(defaultAgent, installed).map((agent) => ({
      kind: 'terminal',
      agent
    }))
  }
  const runnable: TuiAgent[] = []
  const unavailable = new Map<TuiAgent, ChatUnavailableReason>()
  const chatAgents = filterEnabledTuiAgents(args.chatAgents, settings?.disabledTuiAgents)
  const canOpen = (agent: TuiAgent): boolean =>
    chatProgramOffered(args.chatProgram(agent)) ||
    (args.chatProgram(agent) === 'unknown' && installed.includes(agent))
  // Only uninstalled programs: an unreadable one stays a failed check, never an install prompt.
  const needsSetup = (agent: TuiAgent): boolean =>
    args.offerAgentSetup === true &&
    agentSessionInstallCommand(agent, args.hostPlatform) !== null &&
    args.detectedOnHost !== null &&
    !installed.includes(agent) &&
    ['missing', 'installable'].includes(args.chatProgram(agent))
  const chatToo = new Set<TuiAgent>()
  for (const agent of chatAgents) {
    const displayed = nativeChatPreferenceFor(settings, agent)
    if (!displayed && (!installed.includes(agent) || !canOpen(agent))) {
      continue
    }
    const answer = args.hostChatAnswer(agent)
    if (!displayed) {
      if (answer === 'yes') {
        chatToo.add(agent)
      }
      continue
    }
    const program = args.chatProgram(agent)
    if (answer === 'yes' && (canOpen(agent) || needsSetup(agent))) {
      runnable.push(agent)
    } else {
      unavailable.set(
        agent,
        answer === 'yes'
          ? program === 'missing'
            ? 'not-installed'
            : 'check-failed'
          : args.detectedOnHost === null
            ? 'check-failed'
            : answer === 'not-yet-known'
              ? 'check-failed'
              : answer === 'no-chats'
                ? 'not-on-host'
                : answer
      )
    }
  }
  // A host with no agents at all offers chats that set one up, so a first agent is findable.
  if (runnable.length === 0 && unavailable.size === 0 && installed.length === 0) {
    runnable.push(
      ...chatAgents.filter((agent) => needsSetup(agent) && args.hostChatAnswer(agent) === 'yes')
    )
  }
  return [
    ...orderAgentLaunchPickerAgents(defaultAgent, runnable).map((agent) => ({
      kind: 'chat' as const,
      agent
    })),
    ...orderAgentLaunchPickerAgents(defaultAgent, [...unavailable.keys()]).map((agent) => ({
      kind: 'chat-unavailable' as const,
      agent,
      reason: unavailable.get(agent) ?? 'not-on-host'
    })),
    ...orderAgentLaunchPickerAgents(
      defaultAgent,
      installed.filter((agent) => !runnable.includes(agent))
    ).map((agent) => ({
      kind: 'cli' as const,
      agent,
      ...(chatToo.has(agent) ? { chat: true as const } : {})
    }))
  ]
}

export function agentPickerHydrationQueue(
  entries: readonly AgentPickerEntry[],
  selected: () => TuiAgent | undefined
): () => number | undefined {
  const pending = new Set(entries.flatMap((entry, index) => (entry.surfaces.length ? [index] : [])))
  return () => {
    const preferred = entries.findIndex((entry) => entry.agent === selected())
    const index = pending.has(preferred) ? preferred : pending.values().next().value
    if (index !== undefined) {
      pending.delete(index)
    }
    return index
  }
}

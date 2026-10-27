import {
  structuredAgentLaunchSupport,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG } from '../../../shared/protocol-version'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isNativeChatProviderDisplayedOn } from '../../../shared/native-chat/native-chat-providers'
import {
  isNativeChatEnabled,
  type NativeChatDefaultSettings
} from '../../../shared/structured-native-chat-launch-route'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import { orderTabLaunchAgents as orderAgents } from '@/components/tab-bar/tab-agent-launch-options'
import { chatProgramOffered, type ChatProgramObservation } from '@/lib/host-chat-program'

/** What the workspace's machine says about opening an agent as a chat, installation aside. */
export type HostChatAnswer =
  | 'yes'
  | 'not-yet-known'
  | 'ssh'
  | 'wsl'
  | 'subfolder'
  | 'not-on-host'
  | 'no-chats'

export function hostChatAnswer(input: AgentLaunchRoutingInput): HostChatAnswer {
  const support = structuredAgentLaunchSupport(input)
  if (support.supported) {
    return 'yes'
  }
  switch (support.blocker) {
    case 'runtime-capability-unknown':
      return 'not-yet-known'
    case 'agent-without-structured-session':
      return !input.hostStructuredAgents && input.hostCapabilities?.includes(CATALOG) !== false
        ? 'not-yet-known'
        : 'not-on-host'
    case 'remote-execution-host':
      return 'ssh'
    case 'project-runtime':
      return 'wsl'
    case 'runtime-capability':
    case 'client-capability':
      return 'no-chats'
    case 'custom-start-directory':
      return 'subfolder'
    case 'reused-terminal':
      return 'yes'
  }
}

export type ChatUnavailableReason =
  | 'check-failed'
  | 'not-installed'
  | 'ssh'
  | 'wsl'
  | 'subfolder'
  | 'not-on-host'

export type NewTabAgentMenuRow = (
  | { kind: 'chat'; agent: TuiAgent }
  | { kind: 'chat-unavailable'; agent: TuiAgent; reason: ChatUnavailableReason }
  | { kind: 'cli'; agent: TuiAgent }
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
}): NewTabAgentMenuRow[] {
  const { settings } = args
  const defaultAgent = settings?.defaultTuiAgent
  const installed = filterEnabledTuiAgents(args.detectedOnHost ?? [], settings?.disabledTuiAgents)
  if (!isNativeChatEnabled(settings) || args.hostChatAnswer('claude') === 'no-chats') {
    return orderAgents(defaultAgent, installed).map((agent) => ({ kind: 'terminal', agent }))
  }
  const runnable: TuiAgent[] = []
  const unavailable = new Map<TuiAgent, ChatUnavailableReason>()
  const chatAgents = filterEnabledTuiAgents(args.chatAgents, settings?.disabledTuiAgents)
  // An unchosen provider is on wherever its chat program is, whether or not its CLI is.
  const canOpen = (agent: TuiAgent): boolean =>
    chatProgramOffered(args.chatProgram(agent)) ||
    (args.chatProgram(agent) === 'unknown' && installed.includes(agent))
  const providedHere = chatAgents.filter(canOpen)
  for (const agent of chatAgents) {
    if (!isNativeChatProviderDisplayedOn(settings, agent, providedHere)) {
      continue
    }
    const answer = args.hostChatAnswer(agent)
    const program = args.chatProgram(agent)
    if (answer === 'yes' && canOpen(agent)) {
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
  return [
    ...orderAgents(defaultAgent, runnable).map((agent) => ({ kind: 'chat' as const, agent })),
    ...orderAgents(defaultAgent, [...unavailable.keys()]).map((agent) => ({
      kind: 'chat-unavailable' as const,
      agent,
      reason: unavailable.get(agent) ?? 'not-on-host'
    })),
    ...orderAgents(
      defaultAgent,
      installed.filter((agent) => !runnable.includes(agent))
    ).map((agent) => ({ kind: 'cli' as const, agent }))
  ]
}

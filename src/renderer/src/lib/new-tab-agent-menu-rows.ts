import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isNativeChatProviderDisplayedOn } from '../../../shared/native-chat-providers'
import {
  isNativeChatEnabled,
  type NativeChatDefaultSettings
} from '../../../shared/structured-native-chat-launch-route'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import { orderTabLaunchAgents as orderAgents } from '@/components/tab-bar/tab-agent-launch-options'

/** What the workspace's machine says about opening an agent as a chat, installation aside. */
export type HostChatAnswer = 'yes' | 'not-yet-known' | 'ssh' | 'wsl' | 'not-on-host' | 'no-chats'

export type ChatUnavailableReason = 'pending' | 'not-installed' | 'ssh' | 'wsl' | 'not-on-host'

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
  /** The agents detected on the workspace's machine. */
  detectedOnHost: readonly TuiAgent[] | null
  /** The agents Orca can open as a chat. */
  chatAgents: readonly TuiAgent[]
  catalogLoaded?: boolean
  hostChatAnswer: (agent: TuiAgent) => HostChatAnswer
}): NewTabAgentMenuRow[] {
  const { settings } = args
  const defaultAgent = settings?.defaultTuiAgent
  const installed = filterEnabledTuiAgents(args.detectedOnHost ?? [], settings?.disabledTuiAgents)
  if (!isNativeChatEnabled(settings) || args.hostChatAnswer('claude') === 'no-chats') {
    return orderAgents(defaultAgent, installed).map((agent) => ({ kind: 'terminal', agent }))
  }
  const runnable: TuiAgent[] = []
  const unavailable = new Map<TuiAgent, ChatUnavailableReason>()
  const awaitingDefaultOrCatalog = new Set<TuiAgent>()
  const candidates = [
    ...new Set([...args.chatAgents, ...(args.catalogLoaded === false ? installed : [])])
  ]
  for (const agent of filterEnabledTuiAgents(candidates, settings?.disabledTuiAgents)) {
    if (!isNativeChatProviderDisplayedOn(settings, agent, args.detectedOnHost)) {
      continue
    }
    const answer = args.hostChatAnswer(agent)
    if (!args.chatAgents.includes(agent) && answer !== 'ssh' && answer !== 'wsl') {
      unavailable.set(agent, 'pending')
      awaitingDefaultOrCatalog.add(agent)
      continue
    }
    if (answer === 'yes' && installed.includes(agent)) {
      runnable.push(agent)
    } else {
      unavailable.set(
        agent,
        answer === 'yes'
          ? args.detectedOnHost === null
            ? 'pending'
            : 'not-installed'
          : answer === 'not-yet-known'
            ? 'pending'
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
      installed.filter((agent) => !runnable.includes(agent) && !awaitingDefaultOrCatalog.has(agent))
    ).map((agent) => ({ kind: 'cli' as const, agent }))
  ]
}

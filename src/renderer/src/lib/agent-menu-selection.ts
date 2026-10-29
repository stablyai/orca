import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isNativeChatDefaultFor } from '../../../shared/structured-native-chat-launch-route'
import type { AgentLaunchSurface } from './agent-session-launch-plan'
import type { AgentLaunchRoute } from './agent-launch-routing'
import type { HostChatAnswer, NewTabAgentMenuSettings } from './new-tab-agent-menu-rows'

/** Accepted renderer intent; route and explicitness remain distinct through admission. */
export type AgentLaunchChoice = {
  agent: TuiAgent
  route: AgentLaunchRoute
  executionHostId?: ExecutionHostId
  requestedSurface?: AgentLaunchSurface
}

export function resolveAgentMenuSelection(input: {
  agent: TuiAgent | null
  surface?: AgentLaunchSurface
  settings: NewTabAgentMenuSettings | null | undefined
  executionHostId?: ExecutionHostId
  inventoryReady: boolean
  /** No CLI was detected, so only a chat route can start this agent. */
  cliMissing?: boolean
  answer: HostChatAnswer
  chatPending: boolean
  plain: boolean
}): { ready: boolean; choice?: AgentLaunchChoice; cli: boolean } {
  const { agent, surface, answer } = input
  if (agent === null) {
    return { ready: true, cli: false }
  }
  const wantsChat = surface !== 'terminal' && isNativeChatDefaultFor(input.settings, agent)
  const canBeChat = ['yes', 'not-yet-known', 'not-on-host'].includes(answer)
  const pending =
    (surface !== 'terminal' && input.settings == null) ||
    (wantsChat && canBeChat && input.chatPending)
  const route =
    wantsChat && !pending && answer === 'yes' ? 'structured-native-chat' : 'terminal-tui'
  return {
    ready: input.inventoryReady && !pending && !(input.cliMissing && route === 'terminal-tui'),
    cli: !pending && !input.plain && route === 'terminal-tui',
    choice: {
      agent,
      route,
      executionHostId: input.executionHostId,
      ...(surface ? { requestedSurface: route === 'terminal-tui' ? 'terminal' : 'chat' } : {})
    }
  }
}

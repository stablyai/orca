import { useAppStore } from '@/store/index'
import {
  decodeNativeChatAppliedSessionOptions,
  seedNativeChatAppliedSessionOptions
} from '../../../../../shared/native-chat/input/session-options/native-chat-session-option-cache'
import type { SessionOptionValue } from '../../../../../shared/native-chat/input/native-chat-session-options'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

/** Seeds both desktop and paired phones with the launch options. */
export function recordAgentTabAppliedSessionOptions(
  tabId: string,
  agent: TuiAgent,
  rawValues: Record<string, SessionOptionValue> | null | undefined
): void {
  const values = rawValues ? decodeNativeChatAppliedSessionOptions(agent, rawValues) : rawValues
  if (values && seedNativeChatAppliedSessionOptions(tabId, agent, values)) {
    useAppStore.getState().setNativeChatAppliedSessionOptions(tabId, { agent, values })
  }
}

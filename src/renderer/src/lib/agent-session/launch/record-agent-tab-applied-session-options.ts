import { useAppStore } from '@/store/index'
import {
  decodeNativeChatAppliedSessionOptions,
  seedNativeChatAppliedSessionOptions
} from '../../../../../shared/native-chat/input/session-options/native-chat-session-option-cache'
import type { SessionOptionValue } from '../../../../../shared/native-chat/input/native-chat-session-options'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

/** Puts the launch options on the tab, where the host sends them to paired phones. */
export function publishAgentTabAppliedSessionOptions(
  tabId: string,
  agent: TuiAgent,
  rawValues: Record<string, SessionOptionValue> | null | undefined
): void {
  const values = rawValues ? decodeNativeChatAppliedSessionOptions(agent, rawValues) : null
  if (values && Object.keys(values).length > 0) {
    useAppStore.getState().setNativeChatAppliedSessionOptions(tabId, { agent, values })
  }
}

/** A desktop launch seeds the desktop chip exactly as before and publishes for phones. */
export function recordAgentTabAppliedSessionOptions(
  tabId: string,
  agent: TuiAgent,
  rawValues: Record<string, SessionOptionValue> | null | undefined
): void {
  seedNativeChatAppliedSessionOptions(tabId, agent, rawValues)
  publishAgentTabAppliedSessionOptions(tabId, agent, rawValues)
}

import { useAppStore } from '@/store/index'
import { seedNativeChatAppliedSessionOptions } from '../../../../../shared/native-chat/input/session-options/native-chat-session-option-cache'
import type { SessionOptionValue } from '../../../../../shared/native-chat/input/native-chat-session-options'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

/** Seeds both desktop and paired phones with the launch options. */
export function recordAgentTabAppliedSessionOptions(
  tabId: string,
  agent: TuiAgent,
  values: Record<string, SessionOptionValue> | null | undefined
): void {
  seedNativeChatAppliedSessionOptions(tabId, agent, values)
  // Mirrors the seed's own early return: no model, nothing to show.
  if (values && typeof values.model === 'string' && values.model) {
    useAppStore
      .getState()
      .setNativeChatAppliedSessionOptions(tabId, { agent, values: { ...values } })
  }
}

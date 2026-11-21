import { isAgentChatPermissionMode } from '../../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'

/** What an Own pill's hint can truthfully add when it names no mode: that the agent reported one
 *  Orca can't name, or just whose settings apply. Null once a mode is named. A missing report never
 *  promises one is coming: neither the host nor the agent version guarantees a nameable report. */
export type NativeChatPermissionSettingsHint = 'unnamed-report' | 'settings'

export function nativeChatPermissionSettingsHint(input: {
  current: string | undefined
  reported: string | undefined
  /** The agent reported a mode that has no Orca name at all. */
  reportedUnnamed?: boolean
  /** A pick waits for the next message, so the pill names that pick instead. */
  deferred: boolean
}): NativeChatPermissionSettingsHint | null {
  const { current, reported } = input
  if (
    current !== 'own' ||
    input.deferred ||
    isAgentChatPermissionMode(reported) ||
    reported === 'plan'
  ) {
    return null
  }
  return reported !== undefined || input.reportedUnnamed ? 'unnamed-report' : 'settings'
}

import type { NativeChatMessage } from '../../native-chat-types'

/** The turns an automation's row opens: a run, or one no chat took. */
export function nativeChatAutomationTurnKeys(
  rows: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[]
): ReadonlySet<string> {
  return new Set(
    rows.flatMap((message, index) => {
      const key = turnKeys[index]
      return key !== undefined && (message.automationRun || message.automationRunNotStarted)
        ? [key]
        : []
    })
  )
}

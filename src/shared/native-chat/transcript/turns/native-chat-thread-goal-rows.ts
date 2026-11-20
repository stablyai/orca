import {
  AGENT_SESSION_THREAD_GOAL_PRESENTATION,
  isAgentSessionThreadGoalFrame
} from '../../../agent-session/thread-goals/agent-session-thread-goal'
import type { NativeChatMessage } from '../../native-chat-types'
import { AGENT_SESSION_GOAL_CHECK_PRESENTATION } from '../../../agent-session/thread-goals/agent-session-goal-check-display'

export const NATIVE_CHAT_GOAL_CHECK_SUMMARY = 'goal-check-summary'
const summaries = new WeakMap<NativeChatMessage, { count: number; message: NativeChatMessage }>()

/** Keep ended goals' latest check readable through the existing notice disclosure. */
export class NativeChatGoalRows {
  readonly messages: NativeChatMessage[] = []
  private count = 0
  private last: NativeChatMessage | null = null

  append(message: NativeChatMessage, hideGoals = true): void {
    const check =
      message.role === 'system' &&
      message.blocks.some(
        (block) =>
          block.type === 'text' && block.presentation === AGENT_SESSION_GOAL_CHECK_PRESENTATION
      )
    if (hideGoals && check) {
      this.count++
      this.last = message
      return
    }
    if (isNativeChatThreadGoalRow(message) && this.last) {
      const cached = summaries.get(this.last)
      const summary =
        cached?.count === this.count
          ? cached.message
          : {
              ...this.last,
              blocks: this.last.blocks.map((block) =>
                block.type === 'text'
                  ? {
                      ...block,
                      presentation: NATIVE_CHAT_GOAL_CHECK_SUMMARY,
                      tone: 'notice',
                      text: `${this.count}\n${block.text.replace(/^Stop hook feedback: /u, '')}`
                    }
                  : block
              )
            }
      summaries.set(this.last, { count: this.count, message: summary })
      this.messages.push(summary)
      this.count = 0
      this.last = null
    }
    if (!hideGoals || !isNativeChatThreadGoalRow(message)) {
      this.messages.push(message)
    }
  }

  finish(): NativeChatMessage[] {
    return this.messages
  }
}

/** Show goal transitions in the banner only; retain them in the journal. */
export function omitNativeChatThreadGoalRows(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const rows = new NativeChatGoalRows()
  for (const message of messages) {
    rows.append(message)
  }
  return rows.finish()
}

export function isNativeChatThreadGoalRow(message: NativeChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) =>
        block.type === 'text' &&
        (block.presentation === AGENT_SESSION_THREAD_GOAL_PRESENTATION ||
          isAgentSessionThreadGoalFrame(block.providerFrame))
    )
  )
}

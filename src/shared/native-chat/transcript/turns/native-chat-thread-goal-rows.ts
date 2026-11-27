import {
  AGENT_SESSION_THREAD_GOAL_PRESENTATION,
  isAgentSessionThreadGoalFrame
} from '../../../agent-session/thread-goals/agent-session-thread-goal'
import type { NativeChatMessage } from '../../native-chat-types'
import { AGENT_SESSION_GOAL_CHECK_PRESENTATION } from '../../../agent-session/thread-goals/agent-session-goal-check-display'
import { isNativeChatContextClear } from '../../../agent-session/conversation-context/agent-session-context-clear'
import { nativeChatRowRendersProse } from '../folding/native-chat-trailing-run'

export const NATIVE_CHAT_GOAL_CHECK_SUMMARY = 'goal-check-summary'
const summaries = new WeakMap<NativeChatMessage, { count: number; message: NativeChatMessage }>()
const checkedAnswers = new WeakMap<NativeChatMessage, NativeChatMessage>()

/** Keep ended goals' latest check readable through the existing notice disclosure. */
export class NativeChatGoalRows {
  readonly messages: NativeChatMessage[] = []
  private count = 0
  private last: NativeChatMessage | null = null
  private answer: number | null = null

  append(message: NativeChatMessage, hideGoals = true): void {
    const check =
      message.role === 'system' &&
      message.blocks.some(
        (block) =>
          block.type === 'text' && block.presentation === AGENT_SESSION_GOAL_CHECK_PRESENTATION
      )
    if (hideGoals && check) {
      if (this.answer !== null) {
        const answer = this.messages[this.answer]!
        let checked = checkedAnswers.get(answer)
        if (!checked) {
          checked = { ...answer, goalCheckAnswer: true }
          checkedAnswers.set(answer, checked)
        }
        this.messages[this.answer] = checked
        this.answer = null
      }
      this.count++
      this.last = message
      return
    }
    if ((isNativeChatThreadGoalRow(message) || isNativeChatContextClear(message)) && this.last) {
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
      if (message.role === 'assistant' && nativeChatRowRendersProse(message)) {
        this.answer = this.messages.length
      } else if (message.role === 'user' || isNativeChatContextClear(message)) {
        this.answer = null
      }
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

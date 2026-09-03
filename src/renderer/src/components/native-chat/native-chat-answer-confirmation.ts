import { NATIVE_CHAT_QUESTION_STEP_MS } from '../../../../shared/native-chat-answer-stepping'

/**
 * Answering an AskUserQuestion writes selector keystrokes into the agent's TUI.
 * Acceptance of those bytes proves only that the PTY took them — a selector
 * layout the keystrokes do not fit leaves the question live and unanswered
 * (#16865). Until a confirmation signal arrives the answer stays "pending",
 * which keeps the pane's waiting state intact and lets the card come back.
 */
export type NativeChatAnswerConfirmation =
  /** The transcript closed the ask's tool call, or the pane's prompt cleared. */
  | 'confirmed'
  /** No confirmation before the deadline; the question is presumed still live. */
  | 'unconfirmed'

/** Grace added to the keystroke pacing before an unconfirmed answer is judged.
 *
 *  The agent has to redraw its selector, run the tool, and emit the result
 *  through the transcript/hook path; on SSH that round-trip rides the same link
 *  the keystrokes did. Sized to swallow a slow round-trip rather than to react
 *  quickly: a late "still waiting" is a cosmetic delay, but an early one
 *  re-shows a card over a question the agent already answered. */
export const NATIVE_CHAT_ANSWER_CONFIRM_GRACE_MS = 6_000

/**
 * Deadline for a delivered answer's confirmation, measured from the moment
 * delivery settles. Scales with the keystroke pacing because a long selector
 * answer's final group lands proportionally later, and the agent cannot begin
 * resolving the ask until it does.
 */
export function nativeChatAnswerConfirmDeadlineMs(settleAfterMs: number): number {
  return Math.max(settleAfterMs, NATIVE_CHAT_QUESTION_STEP_MS) + NATIVE_CHAT_ANSWER_CONFIRM_GRACE_MS
}

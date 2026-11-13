import {
  CODEX_ASYNC_QUESTION_TOOL,
  parseCodexAsyncQuestionsInput,
  readCodexAsyncQuestionReply
} from '../../../codex-async-question-input'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'

/** One `request_user_input_async` call and the question indexes it still waits on. */
type CodexAsyncQuestionCall = {
  /** The tool input as Codex sent it, published as the row's interactivePrompt. */
  prompt: string
  unanswered: Set<number>
}

/** Pending mid-turn async questions in one Codex pane, by tool call id, oldest first. */
export type CodexAsyncQuestions = Map<string, CodexAsyncQuestionCall>

/** The questions Codex's TUI is holding open for the user; the newest call is shown. */
export type CodexPendingAsyncQuestion = { toolName: string; prompt: string }

/**
 * Codex asks a non-blocking question mid-turn: its status stays working, PostToolUse lands ~20 ms
 * after PreToolUse, and each answer arrives as a UserPromptSubmit reply. Only the hooks show it,
 * so track it here. A skip (Ctrl+]) sends no hook; Orca infers it from the keystroke.
 */
export function trackCodexAsyncQuestions(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): CodexPendingAsyncQuestion | undefined {
  // The TUI drops unanswered questions when the turn ends.
  if (eventName === 'Stop' || eventName === 'Interrupt' || eventName === 'SessionStart') {
    state.codexAsyncQuestionsByPaneKey.delete(paneKey)
    return undefined
  }
  if (
    eventName === 'PreToolUse' &&
    readString(hookPayload, 'tool_name') === CODEX_ASYNC_QUESTION_TOOL
  ) {
    openCall(state, paneKey, hookPayload)
  } else if (eventName === 'UserPromptSubmit') {
    answerCalls(state, paneKey, readString(hookPayload, 'prompt'))
  }
  return pendingCodexAsyncQuestion(state, paneKey)
}

export function pendingCodexAsyncQuestion(
  state: HookListenerState,
  paneKey: string
): CodexPendingAsyncQuestion | undefined {
  const calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)
  const newest = calls ? [...calls.values()].at(-1) : undefined
  return newest ? { toolName: CODEX_ASYNC_QUESTION_TOOL, prompt: newest.prompt } : undefined
}

/** Codex's TUI skips the focused question, which is the oldest unless the user navigated. */
export function skipCodexAsyncQuestion(state: HookListenerState, paneKey: string): boolean {
  const calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)
  const oldest = calls?.entries().next().value
  if (!calls || !oldest) {
    return false
  }
  const [callId, call] = oldest
  const index = call.unanswered.values().next().value
  if (index !== undefined) {
    call.unanswered.delete(index)
  }
  if (call.unanswered.size === 0) {
    calls.delete(callId)
  }
  if (calls.size === 0) {
    state.codexAsyncQuestionsByPaneKey.delete(paneKey)
  }
  return true
}

function openCall(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  const callId = readString(hookPayload, 'tool_use_id')
  const input = hookPayload['tool_input']
  const questions =
    input && typeof input === 'object' && 'questions' in input && Array.isArray(input.questions)
      ? input.questions
      : null
  if (!callId || !questions || !parseCodexAsyncQuestionsInput(input)) {
    return
  }
  let calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)
  if (!calls) {
    calls = new Map()
    state.codexAsyncQuestionsByPaneKey.set(paneKey, calls)
  }
  calls.set(callId, {
    prompt: JSON.stringify(input),
    unanswered: new Set(questions.keys())
  })
}

// Each answer is `[{answer, question, questionItemId: '["request_user_input_async", callId, index]'}]`.
function answerCalls(state: HookListenerState, paneKey: string, prompt: string | undefined): void {
  const calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)
  const replies = readCodexAsyncQuestionReply(prompt)
  if (!calls) {
    return
  }
  // The TUI abandons its questions on plain input; native chat keeps unrelated questions open.
  if (replies === null) {
    state.codexAsyncQuestionsByPaneKey.delete(paneKey)
    return
  }
  for (const [callId, index] of replies) {
    const call = calls.get(callId)
    call?.unanswered.delete(index)
    if (call?.unanswered.size === 0) {
      calls.delete(callId)
    }
  }
  if (calls.size === 0) {
    state.codexAsyncQuestionsByPaneKey.delete(paneKey)
  }
}

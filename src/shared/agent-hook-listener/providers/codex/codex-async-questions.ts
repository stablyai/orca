import {
  CODEX_ASYNC_QUESTION_TOOL,
  parseCodexAsyncQuestionsInput
} from '../../../native-chat/input/questions/codex-async-question-input'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'

/** One `request_user_input_async` call and the question indexes it still waits on. */
type CodexAsyncQuestionCall = {
  /** The tool input as Codex sent it, published as the row's interactivePrompt. */
  prompt: string
  /** Question titles by index; the first unanswered one is the row's tool input. */
  titles: string[]
  /** Ascending, since deletes keep insertion order. */
  unanswered: Set<number>
}

/** Pending mid-turn async questions in one Codex pane, by tool call id, oldest first. */
export type CodexAsyncQuestions = Map<string, CodexAsyncQuestionCall>

const REPLY_OPEN = '<send_user_message_question_reply>'
const REPLY_CLOSE = '</send_user_message_question_reply>'

/** The questions Codex's TUI is holding open for the user. */
export type CodexPendingAsyncQuestion = { toolName: string; prompt: string; title: string }

/**
 * Codex asks a non-blocking question mid-turn: its status stays working, and each answer arrives
 * as a UserPromptSubmit reply. Only the hooks show it, so track it here. PreToolUse runs before
 * Codex validates the input; only an accepted call gets PostToolUse. A skip (Ctrl+]) sends no
 * hook; Orca infers it from the keystroke.
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
    eventName === 'PostToolUse' &&
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
  // Codex's TUI focuses the oldest pending question; the newest call keys the prompt so it rings.
  const oldest = calls?.values().next().value
  const newest = calls ? [...calls.values()].at(-1) : undefined
  const next = oldest?.unanswered.values().next().value
  return oldest && newest && next !== undefined
    ? { toolName: CODEX_ASYNC_QUESTION_TOOL, prompt: newest.prompt, title: oldest.titles[next] }
    : undefined
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
  // Codex accepted every question, so parsed indexes match its reply ids.
  const questions = parseCodexAsyncQuestionsInput(input)?.questions
  if (!callId || !questions) {
    return
  }
  let calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)
  if (!calls) {
    calls = new Map()
    state.codexAsyncQuestionsByPaneKey.set(paneKey, calls)
  }
  calls.set(callId, {
    prompt: JSON.stringify(input),
    titles: questions.map((question) => question.question),
    unanswered: new Set(questions.keys())
  })
}

// Each answer is `[{answer, question, questionItemId: '["request_user_input_async", callId, index]'}]`.
function answerCalls(state: HookListenerState, paneKey: string, prompt: string | undefined): void {
  const calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)
  const body = prompt?.trim()
  if (!calls) {
    return
  }
  // A plain message answers or abandons them all, as native chat's transcript scan reads it.
  if (!body?.startsWith(REPLY_OPEN) || !body.endsWith(REPLY_CLOSE)) {
    state.codexAsyncQuestionsByPaneKey.delete(paneKey)
    return
  }
  for (const [callId, index] of readReplyItems(
    body.slice(REPLY_OPEN.length, -REPLY_CLOSE.length)
  )) {
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

function readReplyItems(json: string): [string, number][] {
  const items = parseJson(json)
  if (!Array.isArray(items)) {
    return []
  }
  return items.flatMap((item): [string, number][] => {
    const id =
      item && typeof item === 'object' && 'questionItemId' in item
        ? parseJson(String(item.questionItemId))
        : null
    return Array.isArray(id) &&
      id[0] === CODEX_ASYNC_QUESTION_TOOL &&
      typeof id[1] === 'string' &&
      typeof id[2] === 'number'
      ? [[id[1], id[2]]]
      : []
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

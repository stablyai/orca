import {
  CODEX_ASYNC_QUESTION_TOOL,
  parseCodexAsyncQuestionsInput
} from '../../../native-chat/input/questions/codex-async-question-input'
import type { ToolSnapshot } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'
import { extractCodexToolFields } from './codex-tool-fields'

/** One `request_user_input_async` call and the question indexes it still waits on. */
type CodexAsyncQuestionCall = {
  /** The tool input as Codex sent it, published as the row's interactivePrompt. */
  prompt: string
  /** Question titles by index; the first unanswered one is the row's tool input. */
  titles: string[]
  /** Ascending, since deletes keep insertion order. */
  unanswered: Set<number>
}

/** One Codex pane's pending mid-turn async questions and the approvals raised over them. */
export type CodexAsyncQuestions = {
  /** By tool call id, oldest first. */
  calls: Map<string, CodexAsyncQuestionCall>
  /** The calls started since, by id, and what each would ask approval as. */
  running: Map<string, string>
  /** Approvals that may still be open, newest last. */
  approvals: { asksAs: string; shown: ToolSnapshot }[]
}

// These take Codex's exclusive tool lock, so their start proves every earlier approval is over.
const STARTS_AFTER_APPROVALS: ReadonlySet<string> = new Set([
  CODEX_ASYNC_QUESTION_TOOL,
  'apply_patch',
  'request_permissions',
  'request_user_input'
])

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
    readString(hookPayload, 'tool_name') === CODEX_ASYNC_QUESTION_TOOL &&
    askedByLiveTurn(state, paneKey, hookPayload)
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
  const calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)?.calls
  // Codex's TUI focuses the oldest pending question; the newest call keys the prompt so it rings.
  const oldest = calls?.values().next().value
  const newest = calls ? [...calls.values()].at(-1) : undefined
  const next = oldest?.unanswered.values().next().value
  return oldest && newest && next !== undefined
    ? { toolName: CODEX_ASYNC_QUESTION_TOOL, prompt: newest.prompt, title: oldest.titles[next] }
    : undefined
}

/** Codex runs calls in parallel, so behind a question the newest approval still open stays on screen. A blocking question runs alone and needs no holding. */
export function codexWaitBesideQuestion(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  reviewerOwnsApproval: boolean
): ToolSnapshot | undefined {
  const open = state.codexAsyncQuestionsByPaneKey.get(paneKey)
  if (!open) {
    return undefined
  }
  const callId = readString(hookPayload, 'tool_use_id')
  // Every hook passes here while a question is open; with no approval to settle, a call's end is only bookkeeping.
  if (eventName === 'PostToolUse' && open.approvals.length === 0) {
    if (callId) {
      open.running.delete(callId)
    }
    return undefined
  }
  const { toolName, toolInput, interactivePrompt } = extractCodexToolFields(eventName, hookPayload)
  const asksAs = approvalAskedAs(toolName, toolInput, hookPayload['tool_input'])
  if (eventName === 'PermissionRequest') {
    // Codex's approvals reviewer decides it while the turn keeps working, so no card the user can't answer covers the question.
    if (reviewerOwnsApproval) {
      const shown = { ...state.lastToolByPaneKey.get(paneKey), toolName, toolInput }
      delete shown.interactivePrompt
      state.lastToolByPaneKey.set(paneKey, shown)
      return shown
    }
    open.approvals.push({ asksAs, shown: { toolName, toolInput, interactivePrompt } })
    // One call can ask again, for a sandbox retry or network access.
    dropEndedApprovals(open, asksAs, 1)
    return undefined
  }
  if (eventName === 'PostToolUse') {
    // Codex rewrites MCP file arguments after approval, so the call's PreToolUse says what it asked as.
    const startedAs = (callId && open.running.get(callId)) || asksAs
    if (callId) {
      open.running.delete(callId)
    }
    dropEndedApprovals(open, startedAs)
    // Another PreToolUse hook can rewrite input, so this call's unfinished twins can ask as it ended.
    const twins = [...open.running.values()].filter((asked) => asked === startedAs).length
    dropEndedApprovals(open, asksAs, twins)
  } else {
    if (eventName !== 'PreToolUse' || STARTS_AFTER_APPROVALS.has(toolName ?? '')) {
      open.approvals = []
      open.running.clear()
    }
    if (eventName === 'PreToolUse' && callId) {
      open.running.set(callId, asksAs)
    }
  }
  const newest = open.approvals.at(-1)
  if (!newest) {
    return undefined
  }
  const shown = { ...state.lastToolByPaneKey.get(paneKey), ...newest.shown }
  state.lastToolByPaneKey.set(paneKey, shown)
  return shown
}

/** Codex's TUI skips the focused question, which is the oldest unless the user navigated. */
export function skipCodexAsyncQuestion(state: HookListenerState, paneKey: string): boolean {
  const calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)?.calls
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

// A call's PreToolUse and PermissionRequest agree on its command or MCP arguments; the other tools that ask run alone, so their name is enough.
function approvalAskedAs(
  toolName: string | undefined,
  toolInput: string | undefined,
  rawInput: unknown
): string {
  return JSON.stringify([toolName, toolName?.startsWith('mcp__') ? rawInput : toolInput])
}

// An approval names no call, so as many can wait as calls that could have asked for them still run.
function dropEndedApprovals(open: CodexAsyncQuestions, asksAs: string, atLeast = 0): void {
  const running = [...open.running.values()].filter((asked) => asked === asksAs).length
  const alike = open.approvals.filter((approval) => approval.asksAs === asksAs)
  const ended = new Set(alike.slice(0, Math.max(0, alike.length - Math.max(atLeast, running))))
  open.approvals = open.approvals.filter((approval) => !ended.has(approval))
}

// Esc can end the turn, and a queued prompt open the next, while an accepted call's hooks run.
function askedByLiveTurn(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): boolean {
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  const turnId = readString(hookPayload, 'turn_id')
  return lead?.state !== 'done' && (!lead?.turnId || !turnId || lead.turnId === turnId)
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
  let open = state.codexAsyncQuestionsByPaneKey.get(paneKey)
  if (!open) {
    open = { calls: new Map(), running: new Map(), approvals: [] }
    state.codexAsyncQuestionsByPaneKey.set(paneKey, open)
  }
  open.calls.set(callId, {
    prompt: JSON.stringify(input),
    titles: questions.map((question) => question.question),
    unanswered: new Set(questions.keys())
  })
}

// Each answer is `[{answer, question, questionItemId: '["request_user_input_async", callId, index]'}]`.
function answerCalls(state: HookListenerState, paneKey: string, prompt: string | undefined): void {
  const calls = state.codexAsyncQuestionsByPaneKey.get(paneKey)?.calls
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

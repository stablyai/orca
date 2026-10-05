// Pending Codex async questions, derived by the execution host from canonical history
// (the rollout file or the journal) and published beside it. The rule: root questions
// asked after the newest delivered root user message, less those a provider reply names.
// Nothing is stored; the set is a pure function of history, so there is no latch to strand.

import { codexAsyncQuestionListsEqual, type CodexAsyncQuestion } from './codex-async-question-item'

export type NativeChatAsyncQuestion = {
  /** Client state key: `["request_user_input_async", <identity>, <index>]`. */
  key: string
  /** The raw provider item id when known; never client identity. */
  providerItemId?: string
  index: number
  title: string
  options?: string[]
}

/** Published side field. `pending`: the host is still reconstructing (not "none").
 *  `absent`: the host can't derive the set right now; clients act as with an old host. */
export type NativeChatAsyncQuestionsField =
  | { state: 'pending' }
  | { state: 'absent' }
  | { state: 'ready'; questions: NativeChatAsyncQuestion[]; omittedCount?: number }

/** Client view: `absent` is also an old host that publishes nothing. */
export type NativeChatAsyncQuestionsView = NativeChatAsyncQuestionsField

export const NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT: NativeChatAsyncQuestionsView = { state: 'absent' }

export type NativeChatAsyncQuestionFact =
  | {
      kind: 'asked'
      asker: 'root' | 'child'
      /** Item-form identity (journal item id, or the rollout's call id). */
      itemId?: string
      /** Identity for a record with no item id (the rollout position). */
      recordId: string
      providerItemId?: string
      questions: CodexAsyncQuestion[]
    }
  | { kind: 'async-call'; callId: string; questions: CodexAsyncQuestion[] }
  | { kind: 'delivered-user-message'; author: 'root' | 'child' }
  /** A delivered reply naming the questions it answers (question keys or whole item ids). */
  | { kind: 'answered'; ids: string[] }
  | { kind: 'other' }

type PendingEntry = {
  identity: string
  /** False for a record-position identity, which no reply can name. */
  replyAddressable: boolean
  providerItemId?: string
  questions: CodexAsyncQuestion[]
  answeredIndexes: number[]
}

export type NativeChatAsyncQuestionFoldState = {
  entries: PendingEntry[]
  /** Async calls since the last delivered message that no message has claimed yet. */
  unclaimedCalls: { callId: string; questions: CodexAsyncQuestion[] }[]
}

export function createNativeChatAsyncQuestionFoldState(): NativeChatAsyncQuestionFoldState {
  return { entries: [], unclaimedCalls: [] }
}

/** An independent copy: the fold replaces entries and calls, never mutates one in place. */
export function cloneNativeChatAsyncQuestionFoldState(
  state: NativeChatAsyncQuestionFoldState
): NativeChatAsyncQuestionFoldState {
  return { entries: [...state.entries], unclaimedCalls: [...state.unclaimedCalls] }
}

function claimCall(state: NativeChatAsyncQuestionFoldState, callId: string): void {
  state.unclaimedCalls = state.unclaimedCalls.filter((call) => call.callId !== callId)
}

/** A record without an item id belongs to a call only when exactly one unclaimed call asked
 *  the same questions; otherwise its own record position is its identity. */
function legacyIdentity(
  state: NativeChatAsyncQuestionFoldState,
  recordId: string,
  questions: readonly CodexAsyncQuestion[]
): { identity: string; replyAddressable: boolean } {
  const matches = state.unclaimedCalls.filter((call) =>
    codexAsyncQuestionListsEqual(call.questions, questions)
  )
  const [match] = matches
  if (matches.length !== 1 || !match) {
    return { identity: recordId, replyAddressable: false }
  }
  claimCall(state, match.callId)
  return { identity: match.callId, replyAddressable: true }
}

/** Retires what a reply names. A record-position entry can't be named, so any reply retires
 *  it, as a plain message would. */
function foldAnswered(state: NativeChatAsyncQuestionFoldState, ids: readonly string[]): boolean {
  const named = new Set(ids)
  let changed = false
  state.entries = state.entries.flatMap((entry) => {
    if (!entry.replyAddressable || named.has(entry.identity)) {
      changed = true
      return []
    }
    const answered = entry.questions.flatMap((_question, index) =>
      !entry.answeredIndexes.includes(index) &&
      named.has(nativeChatAsyncQuestionKey(entry.identity, index))
        ? [index]
        : []
    )
    if (answered.length === 0) {
      return [entry]
    }
    changed = true
    const answeredIndexes = [...entry.answeredIndexes, ...answered]
    return answeredIndexes.length === entry.questions.length ? [] : [{ ...entry, answeredIndexes }]
  })
  return changed
}

/** Folds one fact into `state` in place (forward order); returns whether the set changed. */
export function foldNativeChatAsyncQuestionFact(
  state: NativeChatAsyncQuestionFoldState,
  fact: NativeChatAsyncQuestionFact
): boolean {
  if (fact.kind === 'delivered-user-message') {
    if (fact.author !== 'root') {
      return false
    }
    const changed = state.entries.length > 0
    state.entries = []
    state.unclaimedCalls = []
    return changed
  }
  if (fact.kind === 'answered') {
    return foldAnswered(state, fact.ids)
  }
  if (fact.kind === 'async-call') {
    state.unclaimedCalls.push({ callId: fact.callId, questions: fact.questions })
    return false
  }
  if (fact.kind !== 'asked' || fact.asker !== 'root') {
    return false
  }
  const entry: PendingEntry = {
    ...(fact.itemId
      ? { identity: fact.itemId, replyAddressable: true }
      : legacyIdentity(state, fact.recordId, fact.questions)),
    ...(fact.providerItemId ? { providerItemId: fact.providerItemId } : {}),
    questions: fact.questions,
    answeredIndexes: []
  }
  if (fact.itemId) {
    claimCall(state, fact.itemId)
  }
  // One entry per proven identity: the item form replaces a record already claimed for it.
  const existing = state.entries.findIndex((pending) => pending.identity === entry.identity)
  if (existing !== -1) {
    state.entries[existing] = entry
  } else {
    state.entries.push(entry)
  }
  return true
}

export function nativeChatAsyncQuestionKey(identity: string, index: number): string {
  return JSON.stringify(['request_user_input_async', identity, index])
}

export function nativeChatAsyncQuestionsFromFold(
  state: NativeChatAsyncQuestionFoldState
): NativeChatAsyncQuestion[] {
  return state.entries.flatMap((entry) =>
    entry.questions.flatMap((question, index) =>
      entry.answeredIndexes.includes(index)
        ? []
        : [
            {
              key: nativeChatAsyncQuestionKey(entry.identity, index),
              ...(entry.providerItemId ? { providerItemId: entry.providerItemId } : {}),
              index,
              title: question.title,
              ...(question.options ? { options: question.options } : {})
            }
          ]
    )
  )
}

/** Serialized cap for the side field; a structured frame holds back its actual size from history. */
export const NATIVE_CHAT_ASYNC_QUESTIONS_PUBLICATION_BYTES = 256 * 1024

const encoder = new TextEncoder()

export function nativeChatAsyncQuestionsFieldBytes(field: NativeChatAsyncQuestionsField): number {
  return encoder.encode(JSON.stringify(field)).length
}

/** The oldest questions that fit the budget; the rest stay pending on the host. */
export function publishNativeChatAsyncQuestions(
  questions: readonly NativeChatAsyncQuestion[],
  budgetBytes = NATIVE_CHAT_ASYNC_QUESTIONS_PUBLICATION_BYTES
): NativeChatAsyncQuestionsField {
  // Room for the envelope and a worst-case omittedCount.
  let used = nativeChatAsyncQuestionsFieldBytes({
    state: 'ready',
    questions: [],
    omittedCount: Number.MAX_SAFE_INTEGER
  })
  const published: NativeChatAsyncQuestion[] = []
  for (const question of questions) {
    const bytes = encoder.encode(JSON.stringify(question)).length + 1
    if (used + bytes > budgetBytes) {
      break
    }
    used += bytes
    published.push(question)
  }
  const omittedCount = questions.length - published.length
  return omittedCount > 0
    ? { state: 'ready', questions: published, omittedCount }
    : { state: 'ready', questions: published }
}

export function nativeChatAsyncQuestionsFieldsEqual(
  a: NativeChatAsyncQuestionsField | undefined,
  b: NativeChatAsyncQuestionsField | undefined
): boolean {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b))
}

/** One answered question as sent: its own title and the chosen answer. */
export type NativeChatAsyncQuestionAnswer = { title: string; answer: string }

/** Prose-prefixed so no command classifier on any send path can read it as a command. */
export function formatAsyncQuestionReply(
  answers: readonly NativeChatAsyncQuestionAnswer[]
): string {
  return answers.map(({ title, answer }) => `Question: ${title}\nAnswer: ${answer}`).join('\n\n')
}

/** The questions a client may show, or none for an old host or an unfinished derivation. */
export function nativeChatAsyncQuestionsShown(
  view: NativeChatAsyncQuestionsView
): readonly NativeChatAsyncQuestion[] {
  return view.state === 'ready' ? view.questions : []
}

/** The async question calls whose tool rows fold away: every one while the host is still
 *  deriving (a card may follow), else the calls the card shows. */
export type NativeChatAsyncCallsFolded = 'all' | ReadonlySet<string>

export const NATIVE_CHAT_NO_ASYNC_CALLS_FOLDED: NativeChatAsyncCallsFolded = new Set()

function questionIdentity(question: NativeChatAsyncQuestion): string | null {
  try {
    const parsed: unknown = JSON.parse(question.key)
    return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : null
  } catch {
    return null
  }
}

/** Which async question calls fold away for a client whose card can show. Pending folds them
 *  all, so a cold open never flashes the raw row before the card. Ready names the calls whose
 *  questions the card shows; the set keeps the oldest questions, so the overflow line can cut
 *  short only the newest call it shows, whose row stays. */
export function nativeChatAsyncCallsFolded(
  view: NativeChatAsyncQuestionsView
): NativeChatAsyncCallsFolded {
  if (view.state === 'pending') {
    return 'all'
  }
  if (view.state !== 'ready' || view.questions.length === 0) {
    return NATIVE_CHAT_NO_ASYNC_CALLS_FOLDED
  }
  const callIds = (question: NativeChatAsyncQuestion): string[] =>
    [questionIdentity(question), question.providerItemId].filter((id): id is string => !!id)
  const cut = view.omittedCount ? view.questions.at(-1) : undefined
  const cutIds = new Set(cut ? callIds(cut) : [])
  const ids = new Set<string>()
  for (const question of view.questions) {
    const own = callIds(question)
    if (!own.some((id) => cutIds.has(id))) {
      own.forEach((id) => ids.add(id))
    }
  }
  return ids
}

/** Whether the client knows there is nothing async pending (heuristics may run). */
export function nativeChatAsyncQuestionsAllowHeuristics(
  view: NativeChatAsyncQuestionsView
): boolean {
  return (
    view.state === 'absent' ||
    (view.state === 'ready' && view.questions.length === 0 && !view.omittedCount)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a published side field defensively (wire input). */
export function readNativeChatAsyncQuestionsField(
  value: unknown
): NativeChatAsyncQuestionsField | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('state' in value)) {
    return undefined
  }
  if (value.state === 'pending' || value.state === 'absent') {
    return { state: value.state }
  }
  if (value.state !== 'ready' || !('questions' in value) || !Array.isArray(value.questions)) {
    return undefined
  }
  const questions = value.questions.flatMap((raw: unknown): NativeChatAsyncQuestion[] => {
    if (!isRecord(raw)) {
      return []
    }
    const { key, index, title, options, providerItemId } = raw
    if (typeof key !== 'string' || typeof title !== 'string' || typeof index !== 'number') {
      return []
    }
    const labels = Array.isArray(options)
      ? options.filter((option): option is string => typeof option === 'string')
      : undefined
    return [
      {
        key,
        index,
        title,
        ...(typeof providerItemId === 'string' ? { providerItemId } : {}),
        ...(labels && labels.length > 0 ? { options: labels } : {})
      }
    ]
  })
  const omittedCount =
    'omittedCount' in value && typeof value.omittedCount === 'number' && value.omittedCount > 0
      ? value.omittedCount
      : undefined
  return omittedCount ? { state: 'ready', questions, omittedCount } : { state: 'ready', questions }
}

/** Folds a transcript stream frame into the client view: a hydrating frame states the whole
 *  set (no field = older host); an append states only a change. Null resets (new source).
 *  A re-subscribe's `pending` keeps the last `ready` set on screen until it re-derives. */
export function reduceNativeChatAsyncQuestionsView(
  previous: NativeChatAsyncQuestionsView,
  frame: { type?: string; asyncQuestions?: unknown } | null
): NativeChatAsyncQuestionsView {
  if (!frame) {
    return NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT
  }
  const field = readNativeChatAsyncQuestionsField(frame.asyncQuestions)
  const next = field ?? (frame.type === 'appended' ? previous : NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT)
  return next.state === 'pending' && previous.state === 'ready' ? previous : next
}

/** The side field of an unvalidated stream frame, or undefined (older host / bad shape). */
export function readNativeChatAsyncQuestionsFrameField(
  frame: unknown
): NativeChatAsyncQuestionsField | undefined {
  return isRecord(frame) ? readNativeChatAsyncQuestionsField(frame.asyncQuestions) : undefined
}

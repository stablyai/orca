// The async question card's per-question state as one pure reducer, so desktop and phone
// keep identical rules: keyed by question, pruned only by an authoritative set, the card locked
// only while its own write is in flight, a sent answer held read-only per question while its
// transport holds it, and sent edits cleared only by a delivered outcome.

import {
  buildNativeChatAsyncQuestionReply,
  nativeChatAsyncAnswerDelivered,
  nativeChatAsyncQuestionEditsFromAnswers,
  nativeChatAsyncQuestionsOpen,
  nativeChatAsyncQuestionsSendable,
  pruneNativeChatAsyncQuestionKeys,
  type NativeChatAsyncAnswerOutcome,
  type NativeChatAsyncQuestionEdit,
  type NativeChatAsyncQuestionEdits
} from './native-chat-async-question-answers'
import type { NativeChatAsyncAnswerProgress } from './native-chat-async-answer-progress'
import {
  nativeChatAsyncQuestionsShown,
  type NativeChatAsyncQuestion,
  type NativeChatAsyncQuestionsView
} from './native-chat-async-questions'

/** A delivered send's answers, by the id of the transport record that now holds them. */
export type NativeChatAsyncAnswerSent = {
  receipt: string
  answers: Readonly<Record<string, string>>
}

/** One conversation's card state, kept while the user is in another conversation. */
export type NativeChatAsyncQuestionCardScope = {
  edits: NativeChatAsyncQuestionEdits
  dismissed: Readonly<Record<string, true>>
  sending: boolean
  /** Oldest first, each key in its newest send only. Where each stands is read from the
   *  transport's records every render; an entry leaves with its questions or its accepted send. */
  sent: readonly NativeChatAsyncAnswerSent[]
}
type ScopeState = NativeChatAsyncQuestionCardScope

export type NativeChatAsyncQuestionCardState = ScopeState & {
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  /** Other conversations' state, newest last, so switching back restores it. */
  parked: Readonly<Record<string, ScopeState>>
}

/** What changes one conversation's card. */
export type NativeChatAsyncQuestionScopeAction =
  | { type: 'edit'; key: string; edit: NativeChatAsyncQuestionEdit }
  | { type: 'dismiss'; key: string }
  | { type: 'sending' }
  | {
      type: 'settled'
      scopeKey: string
      outcome: NativeChatAsyncAnswerOutcome
      /** The edits the send carried, given back unless it was delivered. */
      sent: Readonly<Record<string, NativeChatAsyncQuestionEdit>>
      /** A delivered send whose transport record says where it stands from now on. */
      held?: NativeChatAsyncAnswerSent
    }
  | { type: 'forget'; receipts: ReadonlySet<string> }

export type NativeChatAsyncQuestionCardAction =
  | { type: 'observe'; scopeKey: string; view: NativeChatAsyncQuestionsView }
  | NativeChatAsyncQuestionScopeAction

const MAX_PARKED_SCOPES = 16
export const EMPTY_NATIVE_CHAT_ASYNC_QUESTION_CARD_SCOPE: ScopeState = {
  edits: {},
  dismissed: {},
  sending: false,
  sent: []
}
const EMPTY_SCOPE = EMPTY_NATIVE_CHAT_ASYNC_QUESTION_CARD_SCOPE

export function createNativeChatAsyncQuestionCardState(
  scopeKey: string,
  view: NativeChatAsyncQuestionsView
): NativeChatAsyncQuestionCardState {
  return { scopeKey, view, ...EMPTY_SCOPE, parked: {} }
}

function scopeOf(state: NativeChatAsyncQuestionCardState): ScopeState {
  return {
    edits: state.edits,
    dismissed: state.dismissed,
    sending: state.sending,
    sent: state.sent
  }
}

function park(
  parked: Readonly<Record<string, ScopeState>>,
  scopeKey: string,
  scope: ScopeState
): Record<string, ScopeState> {
  const next: Record<string, ScopeState> = { ...parked }
  delete next[scopeKey]
  next[scopeKey] = scope
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PARKED_SCOPES))) {
    delete next[key]
  }
  return next
}

/** Drops answers whose questions `keep` rejects, and then-empty entries; same array if none. */
function filterSent(
  sent: readonly NativeChatAsyncAnswerSent[],
  keep: (entry: NativeChatAsyncAnswerSent) => Readonly<Record<string, string>> | null
): readonly NativeChatAsyncAnswerSent[] {
  let changed = false
  const next: NativeChatAsyncAnswerSent[] = []
  for (const entry of sent) {
    const answers = keep(entry)
    if (answers !== entry.answers) {
      changed = true
    }
    if (answers && Object.keys(answers).length > 0) {
      next.push(answers === entry.answers ? entry : { ...entry, answers })
    }
  }
  return changed ? next : sent
}

function observe(
  scope: ScopeState,
  view: NativeChatAsyncQuestionsView
): Pick<ScopeState, 'edits' | 'dismissed' | 'sent'> {
  return {
    edits: pruneNativeChatAsyncQuestionKeys(view, scope.edits),
    dismissed: pruneNativeChatAsyncQuestionKeys(view, scope.dismissed),
    sent: filterSent(scope.sent, (entry) => pruneNativeChatAsyncQuestionKeys(view, entry.answers))
  }
}

function settle(
  scope: ScopeState,
  action: Extract<NativeChatAsyncQuestionCardAction, { type: 'settled' }>
): ScopeState {
  if (!nativeChatAsyncAnswerDelivered(action.outcome)) {
    return { ...scope, sending: false, edits: { ...action.sent, ...scope.edits } }
  }
  const edits = { ...scope.edits }
  for (const key of Object.keys(action.sent)) {
    delete edits[key]
  }
  const { held } = action
  if (!held) {
    return { ...scope, sending: false, edits }
  }
  // The newest send of a question decides it, so an older one never gives back over it.
  const older = filterSent(scope.sent, (entry) => {
    const kept = Object.entries(entry.answers).filter(([key]) => !(key in held.answers))
    return kept.length === Object.keys(entry.answers).length
      ? entry.answers
      : Object.fromEntries(kept)
  })
  return { ...scope, sending: false, edits, sent: [...older, held] }
}

export function reduceNativeChatAsyncQuestionScope(
  scope: ScopeState,
  action: NativeChatAsyncQuestionScopeAction
): ScopeState {
  switch (action.type) {
    case 'edit':
      return { ...scope, edits: { ...scope.edits, [action.key]: action.edit } }
    case 'dismiss':
      return { ...scope, dismissed: { ...scope.dismissed, [action.key]: true } }
    case 'sending':
      return { ...scope, sending: true }
    case 'settled':
      return settle(scope, action)
    case 'forget': {
      const sent = filterSent(scope.sent, (entry) =>
        action.receipts.has(entry.receipt) ? null : entry.answers
      )
      return sent === scope.sent ? scope : { ...scope, sent }
    }
  }
}

export function reduceNativeChatAsyncQuestionCard(
  state: NativeChatAsyncQuestionCardState,
  action: NativeChatAsyncQuestionCardAction
): NativeChatAsyncQuestionCardState {
  switch (action.type) {
    case 'observe': {
      if (action.scopeKey !== state.scopeKey) {
        const { [action.scopeKey]: restored = EMPTY_SCOPE, ...others } = park(
          state.parked,
          state.scopeKey,
          scopeOf(state)
        )
        return {
          scopeKey: action.scopeKey,
          view: action.view,
          sending: restored.sending,
          ...observe(restored, action.view),
          parked: others
        }
      }
      return action.view === state.view
        ? state
        : { ...state, view: action.view, ...observe(state, action.view) }
    }
    case 'edit':
    case 'dismiss':
    case 'sending':
      return { ...state, ...reduceNativeChatAsyncQuestionScope(scopeOf(state), action) }
    case 'forget': {
      const scope = scopeOf(state)
      const next = reduceNativeChatAsyncQuestionScope(scope, action)
      return next === scope ? state : { ...state, ...next }
    }
    case 'settled': {
      if (action.scopeKey === state.scopeKey) {
        return { ...state, ...settle(scopeOf(state), action) }
      }
      const parked = state.parked[action.scopeKey]
      return parked
        ? { ...state, parked: { ...state.parked, [action.scopeKey]: settle(parked, action) } }
        : state
    }
  }
}

export type NativeChatAsyncQuestionCardView = {
  open: NativeChatAsyncQuestion[]
  omittedCount: number
  /** What each question shows: the user's edit, else an answer the transport holds or gave back. */
  edits: NativeChatAsyncQuestionEdits
  /** Open questions whose sent answer a transport still holds: read-only and left out of Send. */
  held: ReadonlySet<string>
  /** This card's own write is in flight; a transport's hold never sets it. */
  sending: boolean
  canSend: boolean
}

const NONE_HELD: ReadonlySet<string> = new Set()

function answerable(
  card: Pick<NativeChatAsyncQuestionCardView, 'open' | 'held'>
): NativeChatAsyncQuestion[] {
  return card.open.filter((question) => !card.held.has(question.key))
}

export function nativeChatAsyncQuestionScopeView(
  scope: ScopeState,
  view: NativeChatAsyncQuestionsView,
  progress?: NativeChatAsyncAnswerProgress
): NativeChatAsyncQuestionCardView {
  const open = nativeChatAsyncQuestionsOpen(
    nativeChatAsyncQuestionsShown(view),
    new Set(Object.keys(scope.dismissed))
  )
  const held = progress
    ? new Set(
        open.flatMap((question) => (progress.sendingKeys.has(question.key) ? [question.key] : []))
      )
    : NONE_HELD
  let edits = scope.edits
  if (progress) {
    const given = nativeChatAsyncQuestionEditsFromAnswers(open, progress.answers)
    const shown: Record<string, NativeChatAsyncQuestionEdit> = { ...given, ...scope.edits }
    // A held question shows what it sent, never an edit left from before.
    for (const key of held) {
      const sent = given[key]
      if (sent) {
        shown[key] = sent
      }
    }
    edits = shown
  }
  return {
    open,
    omittedCount: view.state === 'ready' ? (view.omittedCount ?? 0) : 0,
    edits,
    held,
    sending: scope.sending,
    canSend: !scope.sending && nativeChatAsyncQuestionsSendable(answerable({ open, held }), edits)
  }
}

/** What an answer seam reports: its outcome, plus the id of the record that now holds a
 *  delivered answer when its transport keeps one the card must read. */
export type NativeChatAsyncAnswerSendResult =
  | NativeChatAsyncAnswerOutcome
  | { outcome: NativeChatAsyncAnswerOutcome; receipt: string }

export type NativeChatAsyncAnswerSeam = (
  text: string,
  answers: Record<string, string>
) => Promise<NativeChatAsyncAnswerSendResult>

/** Sends the answers of the questions no transport holds through `send`, and settles the card
 *  on its honest outcome. */
export function submitNativeChatAsyncQuestionScope(
  card: Pick<NativeChatAsyncQuestionCardView, 'open' | 'held' | 'edits' | 'canSend'> & {
    scopeKey: string
  },
  dispatch: (action: NativeChatAsyncQuestionScopeAction) => void,
  send: NativeChatAsyncAnswerSeam
): void {
  const reply = card.canSend
    ? buildNativeChatAsyncQuestionReply(answerable(card), card.edits)
    : null
  if (!reply) {
    return
  }
  dispatch({ type: 'sending' })
  const sent = nativeChatAsyncQuestionEditsFromAnswers(card.open, reply.answers)
  const { scopeKey } = card
  const settled = (result: NativeChatAsyncAnswerSendResult): void =>
    dispatch(
      typeof result === 'string'
        ? { type: 'settled', scopeKey, outcome: result, sent }
        : {
            type: 'settled',
            scopeKey,
            outcome: result.outcome,
            sent,
            held: { receipt: result.receipt, answers: reply.answers }
          }
    )
  void send(reply.text, reply.answers).then(settled, () => settled('unknown'))
}

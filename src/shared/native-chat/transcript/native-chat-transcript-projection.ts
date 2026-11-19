// Share ordered/filter/fold projection with the host conversation outline so visible user rows agree with renderers.
// Journal subagent rows belong to separate agent transcripts and fold beside their spawn, never into the conversation.

import { nativeChatSemanticRowId, type NativeChatMessage } from '../native-chat-types'
import { compareAgentJournalPositions } from '../../agent-session/journal/agent-session-journal-position'
import { agentJournalItemSubagentId } from '../../agent-session/journal/agent-session-journal-producer'
import { stripNoiseMessages } from './messages/native-chat-noise'
import { automationRunCoversWaitEnded } from '../../automations/automation-run-message'
import type { WaitEnding } from '../../automation-once'
import { foldToolMessages } from '../tools/native-chat-tool-fold'
import { foldSubagentItems } from './subagents/native-chat-subagent-items'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from './turns/native-chat-turn-membership'

/** Timestamp, then id. A null timestamp sorts first so a source that cannot supply
 *  one stays in place rather than jumping to the end. */
export function compareNativeChatMessagesByTime(
  a: NativeChatMessage,
  b: NativeChatMessage
): number {
  const at = a.timestamp ?? Number.NEGATIVE_INFINITY
  const bt = b.timestamp ?? Number.NEGATIVE_INFINITY
  if (at !== bt) {
    return at - bt
  }
  // Split reasoning shares its provider row's key, before that row's answer.
  const aId = nativeChatSemanticRowId(a)
  const bId = nativeChatSemanticRowId(b)
  const aReasoning = aId !== a.id
  const bReasoning = bId !== b.id
  if (aId < bId) {
    return -1
  }
  if (aId > bId) {
    return 1
  }
  return Number(bReasoning) - Number(aReasoning)
}

/** Journal position outranks clocks: batches share timestamps and crash recovery can backdate rows.
 * Unadmitted optimistic sends follow journal rows; only those and journal-less terminal transcripts sort by time. */
export function compareNativeChatTranscriptMessages(
  a: NativeChatMessage,
  b: NativeChatMessage
): number {
  if (a.journalPosition && b.journalPosition) {
    return compareAgentJournalPositions(a.journalPosition, b.journalPosition)
  }
  if (a.journalPosition || b.journalPosition) {
    return a.journalPosition ? -1 : 1
  }
  if (
    a.transcriptOrder !== undefined &&
    b.transcriptOrder !== undefined &&
    a.transcriptOrder !== b.transcriptOrder
  ) {
    return a.transcriptOrder - b.transcriptOrder
  }
  if ((a.transcriptOrder === undefined) !== (b.transcriptOrder === undefined)) {
    return a.transcriptOrder === undefined ? 1 : -1
  }
  return compareNativeChatMessagesByTime(a, b)
}

type NativeChatMessageCompare = (a: NativeChatMessage, b: NativeChatMessage) => number

/** Every field but the blocks agrees, so a revision keeps its place and attribution among the other rows. */
export function sameNativeChatRowPlacement(
  before: NativeChatMessage,
  next: NativeChatMessage
): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime keys are used only for equality, including any extra message fields.
  const keys = Object.keys(before) as (keyof NativeChatMessage)[]
  return (
    keys.length === Object.keys(next).length &&
    keys.every((key) => {
      if (!Object.hasOwn(next, key)) {
        return false
      }
      if (key === 'blocks') {
        return true
      }
      if (key === 'journalPosition') {
        return (
          before.journalPosition?.sequence === next.journalPosition?.sequence &&
          before.journalPosition?.index === next.journalPosition?.index
        )
      }
      // Journal creation position, rather than a revised provider clock, orders these rows.
      return key === 'timestamp' && before.journalPosition && next.journalPosition
        ? true
        : before[key] === next[key]
    })
  )
}

/** One of a subagent's rows, with the conversation turn it happened during. */
export type NativeChatSubagentRow = {
  message: NativeChatMessage
  turnKey: string | undefined
}

export type NativeChatTranscriptProjection = {
  /** The session's own agent's rows. */
  conversation: NativeChatMessage[]
  /** Each subagent's own rows, in order, by the id they carry. */
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
}

const NO_SUBAGENT_ROWS: ReadonlyMap<string, readonly NativeChatSubagentRow[]> = new Map()

function projectRows(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  return stripNoiseMessages(foldToolMessages(foldSubagentItems(messages)))
}

/** Whether a row takes part in foldAutomationRunCards; appending or revising one can change another. */
export function joinsAutomationRunFold(message: NativeChatMessage): boolean {
  return Boolean(
    message.automationRun ||
    message.automationRunNotStarted ||
    message.waitEnded ||
    message.automationSaved?.automation.once
  )
}

/** Hosts before the run row was a wait's only record also wrote a Wait over card for a run; it says
 *  nothing the row doesn't, so it goes. A Couldn't start row whose run a later message carries was
 *  sent again. A wait's creation row learns how it ended from its run or card. Applied to the
 *  conversation's rows before any scope folds them, by every projection (the phone's too). */
export function foldAutomationRunCards(messages: NativeChatMessage[]): NativeChatMessage[] {
  const runs = messages.flatMap((message) => {
    const run = message.automationRun ?? message.automationRunNotStarted?.run
    return run ? [run] : []
  })
  const endings = waitEndings(messages)
  if (runs.length === 0 && endings.size === 0) {
    return messages
  }
  const sent = new Set(messages.flatMap((message) => message.automationRun?.runId ?? []))
  return messages.flatMap((message) => {
    const card = message.waitEnded
    if (card && runs.some((run) => automationRunCoversWaitEnded(run, card))) {
      return []
    }
    const ending = message.automationSaved?.automation.once
      ? endings.get(message.automationSaved.automation.id)
      : undefined
    if (ending) {
      return [endedWait(message, ending)]
    }
    return message.automationRunNotStarted && sent.has(message.automationRunNotStarted.run.runId)
      ? [sentAgain(message)]
      : [message]
  })
}

/** How each wait in the chat ended, by automation id: its run that started, or its ended card. */
function waitEndings(messages: readonly NativeChatMessage[]): Map<string, WaitEnding> {
  const endings = new Map<string, WaitEnding>()
  for (const message of messages) {
    const run = message.automationRun
    if (run?.wait) {
      endings.set(run.automation.id, run.wait)
    } else if (message.waitEnded) {
      endings.set(message.waitEnded.automation.id, message.waitEnded.ending)
    }
  }
  return endings
}

// One marked creation row per source row and ending, so a re-projection keeps its rendered row.
const endedWaitRows = new WeakMap<NativeChatMessage, NativeChatMessage>()

function endedWait(message: NativeChatMessage, ending: WaitEnding): NativeChatMessage {
  const marked = endedWaitRows.get(message)
  if (marked?.savedWaitEnded?.kind === ending.kind && marked.savedWaitEnded.at === ending.at) {
    return marked
  }
  const next = { ...message, savedWaitEnded: ending }
  endedWaitRows.set(message, next)
  return next
}

// One marked row per source row, so a re-projection keeps its identity and its rendered row.
const sentAgainRows = new WeakMap<NativeChatMessage, NativeChatMessage>()

function sentAgain(message: NativeChatMessage): NativeChatMessage {
  let marked = sentAgainRows.get(message)
  if (!marked) {
    marked = {
      ...message,
      automationRunNotStarted: { ...message.automationRunNotStarted!, sentAgain: true }
    }
    sentAgainRows.set(message, marked)
  }
  return marked
}

/** Preserve canonical sequence, inserting ordinary supplemental rows by their actual clocks. */
export function orderNativeChatTranscriptEntries<T>(
  entries: readonly T[],
  messageOf: (entry: T) => NativeChatMessage,
  compare: NativeChatMessageCompare = compareNativeChatTranscriptMessages
): T[] {
  if (entries.some((entry) => messageOf(entry).journalPosition)) {
    return Array.from(entries).sort((a, b) => compare(messageOf(a), messageOf(b)))
  }
  const canonical: T[] = []
  const supplemental: T[] = []
  for (const entry of entries) {
    const message = messageOf(entry)
    const target =
      message.source !== 'transcript' && message.transcriptOrder === undefined
        ? supplemental
        : canonical
    target.push(entry)
  }
  canonical.sort((a, b) => compare(messageOf(a), messageOf(b)))
  supplemental.sort((a, b) => compareNativeChatMessagesByTime(messageOf(a), messageOf(b)))
  const ordered: T[] = []
  let next = 0
  for (const entry of canonical) {
    while (
      next < supplemental.length &&
      compareNativeChatMessagesByTime(messageOf(supplemental[next]!), messageOf(entry)) < 0
    ) {
      ordered.push(supplemental[next++]!)
    }
    ordered.push(entry)
  }
  return ordered.concat(supplemental.slice(next))
}

/** The conversation alone. `compare` lets the renderer order its own tail rows
 *  (streaming, optimistic sends), which never exist on the host. */
export function projectNativeChatTranscriptMessages(
  messages: readonly NativeChatMessage[],
  compare: NativeChatMessageCompare = compareNativeChatTranscriptMessages,
  order?: (messages: readonly NativeChatMessage[]) => NativeChatMessage[]
): NativeChatMessage[] {
  return projectNativeChatTranscript(messages, compare, undefined, order).conversation
}

/** Use conversation turn membership for each subagent row, as though it were a parent row at that position. */
export function projectNativeChatTranscript(
  messages: readonly NativeChatMessage[],
  compare: NativeChatMessageCompare = compareNativeChatTranscriptMessages,
  journal?: NativeChatTurnJournal | null,
  order = (rows: readonly NativeChatMessage[]) =>
    orderNativeChatTranscriptEntries(rows, (row) => row, compare),
  /** Folds one scope: the conversation, or one subagent's rows within one parent turn. */
  projectScope: (rows: readonly NativeChatMessage[]) => NativeChatMessage[] = projectRows
): NativeChatTranscriptProjection {
  const sorted = order(messages)
  const own: NativeChatMessage[] = []
  const byAgent = new Map<string, NativeChatMessage[]>()
  for (const message of sorted) {
    const agentId = agentJournalItemSubagentId(message)
    if (agentId === null) {
      own.push(message)
    } else {
      const rows = byAgent.get(agentId)
      if (rows) {
        rows.push(message)
      } else {
        byAgent.set(agentId, [message])
      }
    }
  }
  const conversation = projectScope(foldAutomationRunCards(own))
  if (byAgent.size === 0) {
    return { conversation, subagentRows: NO_SUBAGENT_ROWS }
  }
  // Only a user row the conversation draws opens a turn by position, never a subagent's.
  const turnStarts = new Set(
    conversation.filter((message) => message.role === 'user').map((message) => message.id)
  )
  const { turnKeys } = nativeChatTurnMembership(sorted, journal, (message) =>
    turnStarts.has(message.id)
  )
  const turnOf = new Map(sorted.map((message, index) => [message, turnKeys[index]]))
  const subagentRows = new Map<string, NativeChatSubagentRow[]>()
  for (const [agentId, rows] of byAgent) {
    // Split subagent folds at parent turn boundaries so edits count in the turn that produced them.
    const projected: NativeChatSubagentRow[] = []
    let chunk: NativeChatMessage[] = []
    let chunkTurn: string | undefined
    const flush = (): void => {
      for (const message of projectScope(chunk)) {
        projected.push({ message, turnKey: chunkTurn })
      }
      chunk = []
    }
    for (const message of rows) {
      const turn = turnOf.get(message)
      if (chunk.length > 0 && turn !== chunkTurn) {
        flush()
      }
      chunkTurn = turn
      chunk.push(message)
    }
    flush()
    subagentRows.set(agentId, projected)
  }
  return { conversation, subagentRows }
}

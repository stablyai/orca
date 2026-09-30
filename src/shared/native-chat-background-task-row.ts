// One background task's durable transcript row: the vocabulary its producer,
// the desktop renderer and the plain-text surfaces all read it by.
//
// Shared because the row is written once and read by clients that cannot draw
// the block. The frozen sentence beside it is built here too, so the twin and
// the block can never describe the task differently.

import {
  isBackgroundTaskBlock,
  type NativeChatBackgroundTaskBlock,
  type NativeChatBlock
} from './native-chat-types'

/** The only states a task can still leave. Everything else is an outcome,
 *  including `unverifiable`, which records that we stopped being able to see
 *  the task rather than what it did (docs/reference/ssh-execution-boundary.md).
 *  A state this build does not know reads as settled, never as in-flight: a row
 *  written by a newer build must not leave the transcript spinning forever. */
const IN_FLIGHT_TASK_STATES: ReadonlySet<string> = new Set(['working', 'monitoring', 'waiting'])

/** The task's own verdict about itself, which a later frame may not overwrite.
 *  `unverifiable` is deliberately absent: contact can return, and latching the
 *  loss would report a task that finished as one we never saw finish. */
const LATCHED_TASK_STATES: ReadonlySet<string> = new Set(['done', 'blocked', 'idle'])

const KNOWN_TASK_STATES = [
  'working',
  'monitoring',
  'waiting',
  'blocked',
  'done',
  'idle',
  'unverifiable'
] as const satisfies NativeChatBackgroundTaskBlock['state'][]

/** A state this build has no word for reads as `unverifiable` — we cannot say
 *  what the task did, only that we cannot name what it reported. */
export function normalizeBackgroundTaskState(
  state: string
): NativeChatBackgroundTaskBlock['state'] {
  return KNOWN_TASK_STATES.find((known) => known === state) ?? 'unverifiable'
}

export function isSettledBackgroundTaskState(state: string): boolean {
  return !IN_FLIGHT_TASK_STATES.has(state)
}

/** Whether `next` may replace `current`. Nothing returns to in-flight once we
 *  have given up on it, so a straggler progress tick cannot re-light a settled
 *  row. */
export function canReplaceBackgroundTaskState(current: string, next: string): boolean {
  if (!isSettledBackgroundTaskState(current)) {
    return true
  }
  if (LATCHED_TASK_STATES.has(current)) {
    return false
  }
  return LATCHED_TASK_STATES.has(next)
}

const KNOWN_TASK_KINDS = [
  'agent',
  'workflow',
  'command',
  'monitor',
  'unknown'
] as const satisfies NativeChatBackgroundTaskBlock['kind'][]

/** A kind this build has no name for is simply an unnamed task, not a guess. */
export function normalizeBackgroundTaskKind(kind: string): NativeChatBackgroundTaskBlock['kind'] {
  return KNOWN_TASK_KINDS.find((known) => known === kind) ?? 'unknown'
}

const KIND_NOUNS: Record<NativeChatBackgroundTaskBlock['kind'], string> = {
  agent: 'background agent',
  workflow: 'background workflow',
  command: 'background command',
  monitor: 'background monitor',
  unknown: 'background task'
}

const SETTLED_VERBS: Record<string, string> = {
  done: 'finished',
  blocked: 'failed',
  idle: 'was stopped'
}

/**
 * Plain-text stand-in for the row, frozen into the journal at write time for
 * clients without the block type — mobile renders only this.
 *
 * It leads with the provider's OWN sentence whenever it sent one: that sentence
 * is the point of the row, and paraphrasing it would discard the only account
 * of the failure the provider ever gave. Everything else states what stays true
 * once the writing process is gone. A live task claims only that it was
 * started, never that it is still running: the clients reading this instead of
 * the block reconcile nothing and cannot re-check the task, so a frozen
 * "running" would assert a liveness only the dead process could have observed.
 */
export function backgroundTaskFallbackText(block: NativeChatBackgroundTaskBlock): string {
  const sentence = block.summary?.trim() || block.error?.trim()
  if (sentence) {
    return sentence
  }
  const noun = KIND_NOUNS[normalizeBackgroundTaskKind(block.kind)]
  // A task the provider never named falls through to its kind: quoting an empty
  // label would print `background command ""`.
  const subject = block.label.trim() ? `${noun} "${block.label}"` : noun
  if (!isSettledBackgroundTaskState(block.state)) {
    return `Started ${subject}`
  }
  const verb = SETTLED_VERBS[block.state] ?? 'stopped reporting'
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${verb}`
}

/** The background-task rows in `blocks`. */
export function backgroundTaskBlocks(
  blocks: readonly NativeChatBlock[]
): NativeChatBackgroundTaskBlock[] {
  return blocks.filter(isBackgroundTaskBlock)
}

export type BackgroundTaskTwinClaims = {
  /** Text blocks a row's frozen twin occupies, by position, so a surface
   *  drawing the block does not print the same sentence beside it. */
  twinTextIndexes: Set<number>
  /** Rows left with no twin, by position, and the sentence each must print
   *  itself on a surface that cannot draw the block. */
  unpairedRows: Map<number, string>
}

/** Pair every task row with the frozen twin written beside it.
 *
 *  Matched on exact text, which the producer guarantees: it writes the twin
 *  from `backgroundTaskFallbackText` and nothing else into the row. A row
 *  written by a newer build that phrases a state differently matches nothing,
 *  and then prints its own sentence beside the unclaimed text — redundant, but
 *  never a lost report, which is the only degradation this row may have. */
export function claimBackgroundTaskTwins(
  blocks: readonly NativeChatBlock[]
): BackgroundTaskTwinClaims {
  const twinTextIndexes = new Set<number>()
  const unpairedRows = new Map<number, string>()
  const wanted = new Map<string, number>()
  const rows: { index: number; sentence: string }[] = []
  blocks.forEach((block, index) => {
    if (isBackgroundTaskBlock(block)) {
      const sentence = backgroundTaskFallbackText(block)
      rows.push({ index, sentence })
      wanted.set(sentence, (wanted.get(sentence) ?? 0) + 1)
    }
  })
  for (const [index, block] of blocks.entries()) {
    const count = block.type === 'text' ? (wanted.get(block.text) ?? 0) : 0
    if (block.type === 'text' && count > 0) {
      wanted.set(block.text, count - 1)
      twinTextIndexes.add(index)
    }
  }
  for (const row of rows) {
    const count = wanted.get(row.sentence) ?? 0
    if (count > 0) {
      wanted.set(row.sentence, count - 1)
      unpairedRows.set(row.index, row.sentence)
    }
  }
  return { twinTextIndexes, unpairedRows }
}

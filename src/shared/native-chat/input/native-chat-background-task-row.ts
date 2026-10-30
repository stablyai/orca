// Build durable task blocks and frozen plain-text twins together so clients without block support read the same report.

import type { AgentJournalMessageItem } from '../../agent-session-journal-types'
import {
  isBackgroundTaskBlock,
  type NativeChatBackgroundTaskBlock,
  type NativeChatBlock
} from '../../native-chat-types'

/** Only these states remain in flight. Unknown/newer states are settled to prevent endless spinners;
 * unverifiable records lost visibility, not task outcome (docs/reference/ssh-execution-boundary.md). */
const IN_FLIGHT_TASK_STATES: ReadonlySet<string> = new Set(['working', 'monitoring', 'waiting'])

/** Latch task verdicts; unverifiable may recover when contact returns, so never latch lost visibility. */
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

/** Unknown states mean unverifiable; do not invent a task outcome. */
export function normalizeBackgroundTaskState(
  state: string
): NativeChatBackgroundTaskBlock['state'] {
  return KNOWN_TASK_STATES.find((known) => known === state) ?? 'unverifiable'
}

export function isSettledBackgroundTaskState(state: string): boolean {
  return !IN_FLIGHT_TASK_STATES.has(state)
}

/** Settled rows cannot return to in-flight from straggler progress ticks. */
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

/** Frozen journal fallback for clients without task blocks (mobile). Preserve the provider’s summary/error verbatim as its only failure report.
 * For live tasks claim only started: fallback readers cannot reconcile/recheck liveness after the writer exits. */
export function backgroundTaskFallbackText(block: NativeChatBackgroundTaskBlock): string {
  const sentence = block.summary?.trim() || block.error?.trim()
  if (sentence) {
    return sentence
  }
  const noun = KIND_NOUNS[normalizeBackgroundTaskKind(block.kind)]
  // An empty label falls back to kind rather than printing empty quotes.
  const subject = block.label.trim() ? `${noun} "${block.label}"` : noun
  if (!isSettledBackgroundTaskState(block.state)) {
    return `Started ${subject}`
  }
  const verb = SETTLED_VERBS[block.state] ?? 'stopped reporting'
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${verb}`
}

export function backgroundTaskJournalBody(
  block: NativeChatBackgroundTaskBlock
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'system',
    blocks: [{ type: 'text', text: backgroundTaskFallbackText(block) }, { ...block }]
  }
}

export function backgroundTaskBlocks(
  blocks: readonly NativeChatBlock[]
): NativeChatBackgroundTaskBlock[] {
  return blocks.filter(isBackgroundTaskBlock)
}

export type BackgroundTaskTwinClaims = {
  /** Frozen-twin text positions consumed by block-rendering surfaces to avoid duplicate sentences. */
  twinTextIndexes: Set<number>
  /** Unpaired block positions and fallback sentences for surfaces without block support. */
  unpairedRows: Map<number, string>
}

/** Pair exact producer-written fallback text. Newer phrasings may produce duplicates but must never lose a report. */
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

// Back-to-back status rows about one thing draw as one: a Dispatch's Started row and its updates, or
// one automation run's rows. The newest row stands for the rest, which open under it (`mergedEvents`).
// Rows only merge into a newer row, so the merged row was the last one drawn when it arrived: it
// turns into the newer row in place, and nothing above it moves.
import type { NativeChatMessage } from '../../native-chat-types'
import type { AutomationRunNotStartedRow } from '../../../agent-journal-orca-card-items'
import type { OrchestrationSessionWorker } from '../../../orchestration-session-workers'
import { agentMessageSessionWorker } from '../../../agent-session/view/messages/agent-message-dispatch'
import { rowDrawsNothing } from '../../../bots/bot-item-note-runs'
import { nativeChatTurnBarRows } from '../turns/native-chat-turn-grouping'

export type NativeChatEventPlanInput = {
  turnKeys: readonly (string | undefined)[]
  /** The chat's own workers, which tell an update's Dispatch; Started rows name theirs. */
  workers: readonly OrchestrationSessionWorker[]
  /** What the surface leaves out: a quiet turn's rows and its bar. */
  quiet?: { rows: ReadonlySet<number>; turns: ReadonlySet<string> }
  /** A turn that draws its diff or opened pull requests after its last row. */
  turnEndsDrawing?: (turnKey: string) => boolean
}

/** What a row is about: its Dispatch or automation run, or null when it never merges. */
function eventSubject(
  message: NativeChatMessage,
  workers: readonly OrchestrationSessionWorker[]
): string | null {
  if (message.queued) {
    return null
  }
  const run =
    message.automationRunNotStarted?.run ??
    (message.role === 'user' ? message.automationRun : undefined)
  if (run) {
    return `run:${run.runId}`
  }
  if (message.agentStart) {
    return message.agentStartDispatchId ? `dispatch:${message.agentStartDispatchId}` : null
  }
  if (message.role !== 'user' || !message.from) {
    return null
  }
  const worker = agentMessageSessionWorker(message, workers)
  return worker ? `dispatch:${worker.dispatchId}` : null
}

export type MergedRunFailure = Pick<AutomationRunNotStartedRow, 'error' | 'refusal'> & {
  id: string
  timestamp: number | null
}

/** The tries of this run that couldn't start, merged into its row, newest first. */
export function mergedRunFailures(message: NativeChatMessage): MergedRunFailure[] | undefined {
  const failures = message.mergedEvents?.flatMap((earlier) =>
    earlier.automationRunNotStarted
      ? [
          {
            id: earlier.id,
            timestamp: earlier.timestamp,
            error: earlier.automationRunNotStarted.error,
            refusal: earlier.automationRunNotStarted.refusal
          }
        ]
      : []
  )
  return failures?.length ? failures : undefined
}

/** Same length and order as `messages`, so per-row facts (`turnKeys`) still line up. */
export function nativeChatEventPlan<T extends readonly NativeChatMessage[]>(
  messages: T,
  { turnKeys, workers, quiet, turnEndsDrawing }: NativeChatEventPlanInput
): T | NativeChatMessage[] {
  const bars = nativeChatTurnBarRows(messages, turnKeys)
  const lastRowByTurn = new Map<string, number>()
  turnKeys.forEach((turnKey, index) => {
    if (turnKey !== undefined) {
      lastRowByTurn.set(turnKey, index)
    }
  })
  const runs: number[][] = []
  let run: number[] = []
  let subject: string | null = null
  const settle = (): void => {
    if (run.length > 1) {
      runs.push(run)
    }
    run = []
    subject = null
  }
  messages.forEach((message, index) => {
    const turnKey = turnKeys[index]
    const bar = turnKey === undefined || quiet?.turns.has(turnKey) ? undefined : bars.get(turnKey)
    const barHere = bar?.index === index
    if (barHere && bar.above) {
      settle()
    }
    if (!quiet?.rows.has(index) && !rowDrawsNothing(message)) {
      const about = eventSubject(message, workers)
      if (about === null || about !== subject) {
        settle()
      }
      if (about !== null) {
        run.push(index)
        subject = about
        // A run that went is never drawn inside a later row, which only lists tries that couldn't start.
        if (message.automationRun && !message.automationRunNotStarted) {
          settle()
        }
      }
    }
    if (
      (barHere && !bar.above) ||
      (turnKey !== undefined &&
        lastRowByTurn.get(turnKey) === index &&
        turnEndsDrawing?.(turnKey) === true)
    ) {
      settle()
    }
  })
  settle()
  if (runs.length === 0) {
    return messages
  }
  const out: NativeChatMessage[] = [...messages]
  for (const indexes of runs) {
    const newest = indexes.at(-1)!
    const survivor = messages[newest]!
    const earlier = indexes.slice(0, -1).map((index) => messages[index]!)
    out[newest] = { ...survivor, mergedEvents: earlier.toReversed() }
    for (const index of indexes.slice(0, -1)) {
      out[index] = { ...messages[index]!, mergedInto: survivor.id }
    }
  }
  return out
}

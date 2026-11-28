// Which settings a bot's tool check ran under (the host's opaque `checkBasis`), so a check from
// before a Codex Arguments change is never shown, and only that bot's readers check again.
import { notifyToolReaders } from './bot-tools-revision'

/** Bumped per bot when its reads are dropped, so only that bot's readers read and check again. */
const dropped = new Map<string, number>()

export const droppedOf = (key: string): number => dropped.get(key) ?? 0

/** Tells the bot's readers (and only theirs) that its reads went. */
export function markDropped(key: string): void {
  dropped.set(key, droppedOf(key) + 1)
  notifyToolReaders()
}

/** A check answered under settings other than the tools' read: never shown, and read again. */
export class StaleCheck extends Error {}

/** The tools, read again, name other settings than the read's checks ran under. */
export const basisMoved = (
  readBasis: string | null | undefined,
  nextBasis: string | undefined
): boolean => readBasis !== undefined && (nextBasis ?? null) !== readBasis

/** A check's answer names other settings than the tools' read (an older host names none). */
export const answeredUnderOther = (
  readBasis: string | null | undefined,
  answerBasis: string | undefined
): boolean => answerBasis !== undefined && Boolean(readBasis) && answerBasis !== readBasis

type BasisRead = { tools: Promise<{ checkBasis?: string }>; basis?: string | null }

/** Keeps the settings the read's tools name, which its checks then run under. */
export function rememberBasis(read: BasisRead): void {
  void read.tools.then(
    (tools) => {
      read.basis ??= tools.checkBasis ?? null
    },
    () => {}
  )
}

/** A check's problems, unless it ran under other settings than `read`'s: then `drop` the read
 *  and throw StaleCheck, so the answer is never shown and the bot checks again. */
export function problemsUnder<P>(
  answer: { problems: P; checkBasis?: string },
  read: BasisRead,
  drop: () => void
): P {
  if (answeredUnderOther(read.basis, answer.checkBasis)) {
    drop()
    throw new StaleCheck()
  }
  return answer.problems
}

/**
 * For the reads kept in `reads`: `invalidate` drops one (stopping its unfinished checks) so its
 * readers alone read again; `droppedForBasis` does so when its tools, read again, name other
 * settings, and says whether the read is no longer current.
 */
export function basisDrops<R extends BasisRead>(
  reads: Map<string, R>,
  stop: (read: R) => void
): {
  invalidate: (key: string, read: R) => void
  droppedForBasis: (key: string, read: R, next: { checkBasis?: string }) => boolean
} {
  const invalidate = (key: string, read: R): void => {
    if (reads.get(key) === read) {
      reads.delete(key)
      stop(read)
      markDropped(key)
    }
  }
  return {
    invalidate,
    droppedForBasis: (key, read, next) => {
      if (reads.get(key) === read && basisMoved(read.basis, next.checkBasis)) {
        invalidate(key, read)
      }
      return reads.get(key) !== read
    }
  }
}

import {
  isCursorNativeAgentTitle,
  normalizeTerminalTitle,
  shouldSuppressCursorNativeTitle
} from '../../../../shared/agent-detection'
import type { AgentStatus } from '../../../../shared/agent-title-core'
import type { PlacedProgramActivity } from '../../../../shared/program-status/title-activity-order'
import type { PendingPtySideEffect } from './pty-output-side-effect-queue'

export function removeSuppressedCursorNativeTitles(
  titles: string[],
  precedingTitle: string | null,
  /** Compacted in lockstep so title offsets stay aligned with the kept titles. */
  titleEnds?: number[]
): boolean {
  let writeIndex = 0
  let previousTitle = precedingTitle
  for (const [readIndex, title] of titles.entries()) {
    if (isCursorNativeAgentTitle(title) && shouldSuppressCursorNativeTitle(previousTitle)) {
      continue
    }
    previousTitle = normalizeTerminalTitle(title)
    titles[writeIndex] = title
    if (titleEnds) {
      titleEnds[writeIndex] = titleEnds[readIndex]
    }
    writeIndex += 1
  }
  const removed = writeIndex < titles.length
  titles.length = writeIndex
  if (titleEnds) {
    titleEnds.length = writeIndex
  }
  return removed
}

type OrderedPtyEffects = Pick<
  PendingPtySideEffect,
  'payloads' | 'containsBell' | 'suppressAttentionEvents'
> & {
  titles: string[]
  placedActivity: readonly PlacedProgramActivity[]
  emptyTitleScanEffect: PendingPtySideEffect['titleScanEffect']
}

/** Group each chunk’s payload/title/activity changes in byte order so drain budgets cannot reorder its effects. */
export function enqueueOrderedPtyEffects(
  enqueue: (effect: PendingPtySideEffect) => void,
  {
    payloads,
    titles,
    placedActivity,
    emptyTitleScanEffect,
    containsBell,
    suppressAttentionEvents
  }: OrderedPtyEffects
): void {
  const entry = (overrides: Partial<PendingPtySideEffect>): PendingPtySideEffect => ({
    payloads: [],
    titles: [],
    titleScanEffect: 'none',
    containsBell: false,
    suppressAttentionEvents,
    ...overrides
  })
  let activityIndex = 0
  const enqueueActivityBefore = (titleIndex: number): void => {
    const due: (AgentStatus | null)[] = []
    while (
      activityIndex < placedActivity.length &&
      placedActivity[activityIndex].beforeTitle <= titleIndex
    ) {
      due.push(placedActivity[activityIndex].activity)
      activityIndex += 1
    }
    if (due.length > 0) {
      enqueue(entry({ programActivity: due }))
    }
  }
  for (const payload of payloads) {
    enqueue(entry({ payloads: [payload] }))
  }
  if (titles.length === 0 && emptyTitleScanEffect !== 'none') {
    enqueue(entry({ titleScanEffect: emptyTitleScanEffect }))
  }
  for (const [index, title] of titles.entries()) {
    enqueueActivityBefore(index)
    enqueue(entry({ titles: [title] }))
  }
  enqueueActivityBefore(titles.length)
  if (containsBell) {
    enqueue(entry({ containsBell: true }))
  }
}

import {
  clearWorkingIndicators,
  createAgentStatusTracker,
  detectAgentStatusFromTitle,
  isCursorNativeAgentTitle,
  normalizeTerminalTitle,
  shouldSuppressCursorNativeTitle
} from '../../../../shared/agent-detection'
import type { IpcPtyTransportOptions } from './pty-transport-types'
import type { PendingPtySideEffect } from './pty-output-side-effect-queue'

const STALE_TITLE_TIMEOUT = 3_000

type PtyOutputTitleObserverOptions = Pick<
  IpcPtyTransportOptions,
  'onTitleChange' | 'onAgentBecameIdle' | 'onAgentBecameWorking' | 'onAgentExited'
> & {
  initialAgentTitle?: string
}

export type PtyOutputTitleObserver = {
  getLastEmittedTitle: () => string | null
  countWorkingTitles: (titles: string[]) => number
  processObservedTitles: (
    titles: string[],
    titleScanEffect: PendingPtySideEffect['titleScanEffect'],
    suppressAgentTracker: boolean,
    observedAtMs?: number
  ) => void
  clearStaleTitleTimer: () => void
  reset: () => void
}

export function createPtyOutputTitleObserver({
  onTitleChange,
  onAgentBecameIdle,
  onAgentBecameWorking,
  onAgentExited,
  initialAgentTitle
}: PtyOutputTitleObserverOptions): PtyOutputTitleObserver {
  let lastEmittedTitle: string | null =
    initialAgentTitle !== undefined ? normalizeTerminalTitle(initialAgentTitle) : null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  // Why: the tracker's exit callback takes no args; the drain names the bytes' arrival time here.
  let titleObservedAtMs: number | undefined
  const initialTrackerTitle =
    initialAgentTitle !== undefined && !isCursorNativeAgentTitle(initialAgentTitle)
      ? initialAgentTitle
      : undefined
  const agentTracker =
    onAgentBecameIdle || onAgentBecameWorking || onAgentExited
      ? createAgentStatusTracker(
          (title) => onAgentBecameIdle?.(title),
          onAgentBecameWorking,
          onAgentExited
            ? () => onAgentExited({ observedAtMs: titleObservedAtMs ?? Date.now() })
            : undefined,
          initialTrackerTitle
        )
      : null

  function isWorkingTitle(title: string | null): boolean {
    return title !== null && detectAgentStatusFromTitle(title) === 'working'
  }

  function countWorkingTitles(titles: string[]): number {
    let count = 0
    for (const title of titles) {
      if (isWorkingTitle(normalizeTerminalTitle(title))) {
        count += 1
      }
    }
    return count
  }

  function applyObservedTerminalTitle(title: string, suppressAgentTracker = false): void {
    lastEmittedTitle = normalizeTerminalTitle(title)
    onTitleChange?.(lastEmittedTitle, title)
    if (!suppressAgentTracker) {
      agentTracker?.handleTitle(title)
    }
  }

  function clearStaleTitleTimer(): void {
    if (staleTitleTimer !== null) {
      clearTimeout(staleTitleTimer)
      staleTitleTimer = null
    }
  }

  function processObservedTitles(
    titles: string[],
    titleScanEffect: PendingPtySideEffect['titleScanEffect'],
    suppressAgentTracker: boolean,
    observedAtMs?: number
  ): void {
    if (!onTitleChange) {
      return
    }
    titleObservedAtMs = observedAtMs
    if (titles.length > 0) {
      clearStaleTitleTimer()
      for (const title of titles) {
        if (isCursorNativeAgentTitle(title)) {
          if (!shouldSuppressCursorNativeTitle(lastEmittedTitle)) {
            applyObservedTerminalTitle(title, true)
          }
          continue
        }
        applyObservedTerminalTitle(title, suppressAgentTracker)
      }
    } else if (titleScanEffect === 'ignored-cursor-native') {
      clearStaleTitleTimer()
    } else if (
      titleScanEffect === 'stale-probe' &&
      !suppressAgentTracker &&
      isWorkingTitle(lastEmittedTitle)
    ) {
      clearStaleTitleTimer()
      const probedAtMs = observedAtMs
      staleTitleTimer = setTimeout(() => {
        staleTitleTimer = null
        titleObservedAtMs = probedAtMs
        if (isWorkingTitle(lastEmittedTitle)) {
          const cleared = clearWorkingIndicators(lastEmittedTitle ?? '')
          lastEmittedTitle = cleared
          onTitleChange(cleared, cleared)
          agentTracker?.handleTitle(cleared)
        }
      }, STALE_TITLE_TIMEOUT)
    }
  }

  return {
    getLastEmittedTitle: () => lastEmittedTitle,
    countWorkingTitles,
    processObservedTitles,
    clearStaleTitleTimer,
    reset: () => {
      clearStaleTitleTimer()
      agentTracker?.reset()
    }
  }
}

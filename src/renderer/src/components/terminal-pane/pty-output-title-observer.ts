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
    suppressAgentTracker: boolean
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
  const initialTrackerTitle =
    initialAgentTitle !== undefined && !isCursorNativeAgentTitle(initialAgentTitle)
      ? initialAgentTitle
      : undefined
  const agentTracker =
    onAgentBecameIdle || onAgentBecameWorking || onAgentExited
      ? createAgentStatusTracker(
          (title) => onAgentBecameIdle?.(title),
          onAgentBecameWorking,
          onAgentExited,
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
    suppressAgentTracker: boolean
  ): void {
    if (!onTitleChange) {
      return
    }
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
      staleTitleTimer = setTimeout(() => {
        staleTitleTimer = null
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

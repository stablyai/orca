import { describe, expect, it } from 'vitest'
import {
  reconcileActivityPortalThreads,
  resolveActivityPortalSwap,
  type ActivityPortalThreadRef
} from './activity-portal-thread-reconciliation'

const thread = (tabId: string, leafId: string): ActivityPortalThreadRef => ({
  paneKey: `${tabId}:${leafId}`,
  worktree: { id: `wt-${tabId}` },
  tab: { id: tabId }
})

// Two tabs in one worktree (staging applies) plus one in another worktree.
const ALL_THREADS = [
  thread('tab-a', 'leaf-1'),
  thread('tab-b', 'leaf-2'),
  thread('tab-c', 'leaf-3')
]

/** Replays ActivityPrototypePage's swap layout effect over a fixed selection. */
function replaySwapCascade(args: {
  selectedThread: ActivityPortalThreadRef
  initialDisplayedPaneKey: string | null
  steps: number
}): string[] {
  let displayedPaneKey = args.initialDisplayedPaneKey
  const kinds: string[] = []
  for (let step = 0; step < args.steps; step += 1) {
    const displayedThread = displayedPaneKey
      ? (ALL_THREADS.find((entry) => entry.paneKey === displayedPaneKey) ?? null)
      : null
    const { visibleThread, stagedThread } = reconcileActivityPortalThreads({
      selectedThread: args.selectedThread,
      displayedThread,
      selectedHasLiveTab: true,
      displayedHasLiveTab: true
    })
    // Most permissive readiness the page can hand in, so no swap is withheld.
    const swap = resolveActivityPortalSwap({
      selectedThread: args.selectedThread,
      selectedHasLiveTab: true,
      visibleThread,
      stagedThread,
      visiblePortalReady: true,
      stagedPortalReady: true,
      stagedPortalUnavailable: true
    })
    kinds.push(swap?.kind ?? 'none')
    if (swap?.kind === 'clear') {
      displayedPaneKey = null
    } else if (swap) {
      displayedPaneKey = swap.paneKey
    }
  }
  return kinds
}

describe('resolveActivityPortalSwap cascade', () => {
  // Why this matters: the swap effect writes setActivePortalSlotId/setDisplayedPaneKey straight from a
  // layout effect. If 'swap-staged' could resolve on two consecutive commits it would toggle the slot
  // forever on React's sync lane. It cannot, so the effect needs no churn budget.
  it('never resolves swap-staged twice in a row for a fixed selection', () => {
    for (const selectedThread of ALL_THREADS) {
      for (const displayed of [null, ...ALL_THREADS]) {
        const kinds = replaySwapCascade({
          selectedThread,
          initialDisplayedPaneKey: displayed?.paneKey ?? null,
          steps: 6
        })
        const label = `selected=${selectedThread.paneKey} displayed=${displayed?.paneKey ?? 'null'}`
        expect(
          kinds.filter((kind) => kind === 'swap-staged').length,
          `${label}: ${kinds.join(',')}`
        ).toBeLessThanOrEqual(1)
        // And the cascade settles: no write at all once displayedPaneKey caught up.
        expect(kinds.at(-1), `${label}: ${kinds.join(',')}`).toBe('settle-visible')
      }
    }
  })

  it('stages across tabs and refuses to stage inside one tab', () => {
    const sameTabDisplayed = reconcileActivityPortalThreads({
      selectedThread: thread('tab-a', 'leaf-9'),
      displayedThread: ALL_THREADS[0],
      selectedHasLiveTab: true,
      displayedHasLiveTab: true
    })
    expect(sameTabDisplayed.stagedThread).toBeNull()

    const crossTabDisplayed = reconcileActivityPortalThreads({
      selectedThread: ALL_THREADS[1],
      displayedThread: ALL_THREADS[0],
      selectedHasLiveTab: true,
      displayedHasLiveTab: true
    })
    expect(crossTabDisplayed.stagedThread).toBe(ALL_THREADS[1])
  })
})

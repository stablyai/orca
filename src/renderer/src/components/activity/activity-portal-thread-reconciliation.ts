export type ActivityPortalThreadRef = {
  paneKey: string
  worktree: { id: string }
  tab: { id: string }
}

export type ActivityPortalReconciliation<TThread extends ActivityPortalThreadRef> = {
  displayedIsSelectedTerminal: boolean
  visibleThread: TThread | null
  stagedThread: TThread | null
}

/** Picks the visible and staged Activity portal threads. */
export function reconcileActivityPortalThreads<TThread extends ActivityPortalThreadRef>(args: {
  selectedThread: TThread | null
  displayedThread: TThread | null
  selectedHasLiveTab: boolean
  displayedHasLiveTab: boolean
}): ActivityPortalReconciliation<TThread> {
  const { selectedThread, displayedThread, selectedHasLiveTab, displayedHasLiveTab } = args
  // Why: same-tab panes share one TerminalPane and swap through isolatedPaneKey, not staging.
  const displayedIsSelectedTerminal = Boolean(
    selectedThread &&
    displayedThread &&
    displayedThread.worktree.id === selectedThread.worktree.id &&
    displayedThread.tab.id === selectedThread.tab.id
  )
  const visibleThread =
    selectedThread && selectedHasLiveTab
      ? displayedThread && displayedHasLiveTab && displayedThread.paneKey !== selectedThread.paneKey
        ? displayedIsSelectedTerminal
          ? selectedThread
          : displayedThread
        : selectedThread
      : null
  const stagedThread =
    selectedThread &&
    selectedHasLiveTab &&
    visibleThread &&
    visibleThread.paneKey !== selectedThread.paneKey &&
    !displayedIsSelectedTerminal
      ? selectedThread
      : null
  return { displayedIsSelectedTerminal, visibleThread, stagedThread }
}

export type ActivityPortalSwap =
  | { kind: 'clear' }
  | { kind: 'swap-staged'; paneKey: string }
  | { kind: 'settle-visible'; paneKey: string }
  | null

/** Decides how displayedPaneKey advances for one commit. */
export function resolveActivityPortalSwap<TThread extends ActivityPortalThreadRef>(args: {
  displayedPaneKey: string | null
  selectedThread: TThread | null
  selectedHasLiveTab: boolean
  visibleThread: TThread | null
  stagedThread: TThread | null
  visiblePortalReady: boolean
  stagedPortalReady: boolean
  stagedPortalUnavailable: boolean
}): ActivityPortalSwap {
  const {
    displayedPaneKey,
    selectedThread,
    selectedHasLiveTab,
    visibleThread,
    stagedThread,
    visiblePortalReady,
    stagedPortalReady,
    stagedPortalUnavailable
  } = args
  if (!selectedThread || !selectedHasLiveTab) {
    if (displayedPaneKey === null) {
      return null
    }
    return { kind: 'clear' }
  }
  if (stagedThread && (stagedPortalReady || stagedPortalUnavailable)) {
    return { kind: 'swap-staged', paneKey: stagedThread.paneKey }
  }
  if (
    displayedPaneKey !== selectedThread.paneKey &&
    !stagedThread &&
    visibleThread?.paneKey === selectedThread.paneKey &&
    visiblePortalReady
  ) {
    return { kind: 'settle-visible', paneKey: selectedThread.paneKey }
  }
  return null
}

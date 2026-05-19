import { useLayoutEffect, useState } from 'react'

export type ActivityTerminalPortalTarget = {
  slotId: string
  requestToken: string
  target: HTMLElement
  worktreeId: string
  tabId: string
  // Why: each Activity thread targets one stable terminal leaf inside a tab.
  // Carry the durable paneKey across this boundary; TerminalPane resolves it
  // to the current numeric PaneManager handle immediately before isolation.
  paneKey: string
  forceUnavailable?: boolean
  active: boolean
}

let currentTargets: ActivityTerminalPortalTarget[] = []
const subscribers = new Set<(targets: ActivityTerminalPortalTarget[]) => void>()

// Why: the portal target is published with its {worktreeId, tabId} already
// attached so consumers don't have to derive routing from the global
// activeTabId/activeWorktreeId. The activity page knows which agent pane it
// wants to display; deriving from global active state introduced a race where
// repo/worktree updates landed before the matching setActiveTab, briefly
// portaling a different terminal into the activity slot ("flash" of the wrong
// terminal for a few ms).
export function setActivityTerminalPortals(targets: ActivityTerminalPortalTarget[]): void {
  if (currentTargets === targets) {
    return
  }
  currentTargets = targets
  for (const subscriber of subscribers) {
    subscriber(targets)
  }
}

export function useActivityTerminalPortals(enabled: boolean): ActivityTerminalPortalTarget[] {
  const [targets, setTargets] = useState<ActivityTerminalPortalTarget[]>(
    enabled ? currentTargets : []
  )

  useLayoutEffect(() => {
    if (!enabled) {
      setTargets([])
      return
    }
    setTargets(currentTargets)
    const subscriber = (next: ActivityTerminalPortalTarget[]): void => setTargets(next)
    subscribers.add(subscriber)
    return () => {
      subscribers.delete(subscriber)
    }
  }, [enabled])

  return targets
}

export function findActivityTerminalPortal(
  targets: ActivityTerminalPortalTarget[],
  query: {
    worktreeId: string
    tabId: string
    slotId?: string
    paneKey?: string
    requestToken?: string
  }
): ActivityTerminalPortalTarget | null {
  const matchingTab = targets.filter(
    (target) => target.worktreeId === query.worktreeId && target.tabId === query.tabId
  )
  if (
    query.slotId !== undefined ||
    query.paneKey !== undefined ||
    query.requestToken !== undefined
  ) {
    const exact = matchingTab.find(
      (target) =>
        (query.slotId === undefined || target.slotId === query.slotId) &&
        (query.paneKey === undefined || target.paneKey === query.paneKey) &&
        (query.requestToken === undefined || target.requestToken === query.requestToken)
    )
    if (exact) {
      return exact
    }
  }
  return (
    matchingTab.find((target) => target.active) ??
    (matchingTab.length === 1 ? matchingTab[0] : null) ??
    null
  )
}

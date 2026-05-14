import { useLayoutEffect, useState } from 'react'

export type ActivityTerminalPortalTarget = {
  slotId: string
  target: HTMLElement
  worktreeId: string
  tabId: string
  // Why: each Activity thread is keyed on a single agent pane within a tab.
  // Carrying paneId here lets TerminalPane isolate that pane visually
  // (hiding split siblings) without touching the user-facing expanded-pane
  // state or the persisted layout snapshot.
  paneId: number | null
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
  worktreeId: string,
  tabId: string
): ActivityTerminalPortalTarget | null {
  return (
    targets.find((target) => target.worktreeId === worktreeId && target.tabId === tabId) ?? null
  )
}

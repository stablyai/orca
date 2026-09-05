import { useCallback, useMemo, useSyncExternalStore } from 'react'

export type TerminalSurfacePortalTarget = {
  slotId: string
  requestToken: string
  target: HTMLElement
  worktreeId: string
  tabId: string
  // Why: each Activity thread targets one stable terminal leaf inside a tab.
  // Carry the durable paneKey across this boundary; TerminalPane resolves it
  // to the current numeric PaneManager handle immediately before isolation.
  paneKey?: string
  forceUnavailable?: boolean
  active: boolean
}

export type ActivityTerminalPortalTarget = TerminalSurfacePortalTarget & { paneKey: string }

let currentTargets: TerminalSurfacePortalTarget[] = []
const emptyTargets: TerminalSurfacePortalTarget[] = []
const subscribers = new Set<() => void>()

type TerminalSurfacePortalFieldEquals = (
  left: TerminalSurfacePortalTarget,
  right: TerminalSurfacePortalTarget
) => boolean

// Why the keyed record: a dropped field here silently suppresses a publish and
// strands Terminal on stale routing — the wrong-terminal flash this file exists
// to prevent. `satisfies` turns a new descriptor field into a build error.
const TERMINAL_SURFACE_PORTAL_FIELD_EQUALS: readonly TerminalSurfacePortalFieldEquals[] =
  Object.values({
    slotId: (left, right) => left.slotId === right.slotId,
    requestToken: (left, right) => left.requestToken === right.requestToken,
    target: (left, right) => left.target === right.target,
    worktreeId: (left, right) => left.worktreeId === right.worktreeId,
    tabId: (left, right) => left.tabId === right.tabId,
    paneKey: (left, right) => left.paneKey === right.paneKey,
    forceUnavailable: (left, right) => left.forceUnavailable === right.forceUnavailable,
    active: (left, right) => left.active === right.active
  } satisfies Record<keyof TerminalSurfacePortalTarget, TerminalSurfacePortalFieldEquals>)

function haveSameTerminalSurfacePortals(
  left: readonly TerminalSurfacePortalTarget[],
  right: readonly TerminalSurfacePortalTarget[]
): boolean {
  return (
    left.length === right.length &&
    left.every((target, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        TERMINAL_SURFACE_PORTAL_FIELD_EQUALS.every((isEqual) => isEqual(target, candidate))
      )
    })
  )
}

// Why: the portal target is published with its {worktreeId, tabId} already
// attached so consumers don't have to derive routing from the global
// activeTabId/activeWorktreeId. The activity page knows which agent pane it
// wants to display; deriving from global active state introduced a race where
// repo/worktree updates landed before the matching setActiveTab, briefly
// portaling a different terminal into the activity slot ("flash" of the wrong
// terminal for a few ms).
export function setTerminalSurfacePortals(targets: TerminalSurfacePortalTarget[]): void {
  // Why: semantic no-ops must not synchronously bounce through Terminal and back into Activity.
  if (currentTargets === targets || haveSameTerminalSurfacePortals(currentTargets, targets)) {
    return
  }
  currentTargets = targets
  for (const subscriber of subscribers) {
    subscriber()
  }
}

export function setActivityTerminalPortals(targets: ActivityTerminalPortalTarget[]): void {
  setTerminalSurfacePortals(targets)
}

function subscribeActivityTerminalPortals(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  return () => {
    subscribers.delete(onStoreChange)
  }
}

export function useTerminalSurfacePortals(enabled: boolean): TerminalSurfacePortalTarget[] {
  // Why: portal targets live in module state so Terminal can consume them
  // without routing through the app store; subscribe as an external store.
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      enabled ? subscribeActivityTerminalPortals(onStoreChange) : () => {},
    [enabled]
  )

  const getSnapshot = useCallback(() => (enabled ? currentTargets : emptyTargets), [enabled])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function hasPaneKey(target: TerminalSurfacePortalTarget): target is ActivityTerminalPortalTarget {
  return target.paneKey !== undefined
}

export function useActivityTerminalPortals(enabled: boolean): ActivityTerminalPortalTarget[] {
  const targets = useTerminalSurfacePortals(enabled)
  // Why: the Multiplexer publishes pane-less targets on the same channel.
  return useMemo(() => targets.filter(hasPaneKey), [targets])
}

export function findTerminalSurfacePortal(
  targets: TerminalSurfacePortalTarget[],
  query: {
    worktreeId: string
    tabId: string
    slotId?: string
    paneKey?: string
    requestToken?: string
  }
): TerminalSurfacePortalTarget | null {
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

export function findActivityTerminalPortal(
  targets: ActivityTerminalPortalTarget[],
  query: Parameters<typeof findTerminalSurfacePortal>[1]
): ActivityTerminalPortalTarget | null {
  return findTerminalSurfacePortal(targets, query) as ActivityTerminalPortalTarget | null
}

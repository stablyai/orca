import { useCallback, useSyncExternalStore } from 'react'

export type ActivityTerminalPortalTarget = {
  slotId: string
  requestToken: string
  target: HTMLElement
  worktreeId: string
  tabId: string
  // Carry the durable leaf paneKey; TerminalPane resolves its current numeric handle immediately before isolation.
  /** Null shows the whole tab. */
  paneKey: string | null
  forceUnavailable?: boolean
  active: boolean
  /** The target's page is off screen: the terminal stays mounted in it without rendering as visible. */
  hidden?: boolean
}

let activityTargets: ActivityTerminalPortalTarget[] = []
let crossWorkspacePaneTarget: ActivityTerminalPortalTarget | null = null
let currentTargets: ActivityTerminalPortalTarget[] = []
const emptyTargets: ActivityTerminalPortalTarget[] = []
const subscribers = new Set<() => void>()

type ActivityTerminalPortalFieldEquals = (
  left: ActivityTerminalPortalTarget,
  right: ActivityTerminalPortalTarget
) => boolean

// Require every descriptor field in this keyed record; omitted equality checks would suppress publication and strand Terminal on stale routing.
const ACTIVITY_TERMINAL_PORTAL_FIELD_EQUALS: readonly ActivityTerminalPortalFieldEquals[] =
  Object.values({
    slotId: (left, right) => left.slotId === right.slotId,
    requestToken: (left, right) => left.requestToken === right.requestToken,
    target: (left, right) => left.target === right.target,
    worktreeId: (left, right) => left.worktreeId === right.worktreeId,
    tabId: (left, right) => left.tabId === right.tabId,
    paneKey: (left, right) => left.paneKey === right.paneKey,
    forceUnavailable: (left, right) => left.forceUnavailable === right.forceUnavailable,
    active: (left, right) => left.active === right.active,
    hidden: (left, right) => left.hidden === right.hidden
  } satisfies Record<keyof ActivityTerminalPortalTarget, ActivityTerminalPortalFieldEquals>)

function haveSameActivityTerminalPortals(
  left: readonly ActivityTerminalPortalTarget[],
  right: readonly ActivityTerminalPortalTarget[]
): boolean {
  return (
    left.length === right.length &&
    left.every((target, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        ACTIVITY_TERMINAL_PORTAL_FIELD_EQUALS.every((isEqual) => isEqual(target, candidate))
      )
    })
  )
}

function publishTerminalPortals(): void {
  const targets = crossWorkspacePaneTarget
    ? [...activityTargets, crossWorkspacePaneTarget]
    : activityTargets
  // Why: semantic no-ops must not synchronously bounce through Terminal and back into Activity.
  if (currentTargets === targets || haveSameActivityTerminalPortals(currentTargets, targets)) {
    return
  }
  currentTargets = targets
  for (const subscriber of subscribers) {
    subscriber()
  }
}

// Publish worktree/tab routing with the target; deriving it from global active state briefly portaled the wrong terminal when activation writes arrived separately.
export function setActivityTerminalPortals(targets: ActivityTerminalPortalTarget[]): void {
  activityTargets = targets
  publishTerminalPortals()
}

/** The cross-workspace pane borrows its tab's terminal the way an Activity slot does. */
export function setCrossWorkspacePaneTerminalPortal(
  target: ActivityTerminalPortalTarget | null
): void {
  crossWorkspacePaneTarget = target
  publishTerminalPortals()
}

function subscribeActivityTerminalPortals(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  return () => {
    subscribers.delete(onStoreChange)
  }
}

export function useActivityTerminalPortals(enabled: boolean): ActivityTerminalPortalTarget[] {
  // Subscribe directly to module state so Terminal can consume targets without app-store routing.
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      enabled ? subscribeActivityTerminalPortals(onStoreChange) : () => {},
    [enabled]
  )

  const getSnapshot = useCallback(() => (enabled ? currentTargets : emptyTargets), [enabled])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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
  const sameTab = targets.filter(
    (target) => target.worktreeId === query.worktreeId && target.tabId === query.tabId
  )
  // A target on screen wins, so Activity can show a tab the hidden cross-workspace pane also holds.
  const shown = sameTab.filter((target) => !target.hidden)
  const matchingTab = shown.length > 0 ? shown : sameTab
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

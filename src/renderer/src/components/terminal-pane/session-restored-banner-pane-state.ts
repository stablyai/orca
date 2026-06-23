import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

export type SessionRestoredBannerPane = Pick<ManagedPane, 'id' | 'container'>

export type SessionRestoredBannerStartup =
  | {
      showSessionRestoredBanner?: boolean
    }
  | null
  | undefined

export type SessionRestoredBannerDismissEvent = KeyboardEvent | PointerEvent

export function addSessionRestoredBannerPaneId(
  paneIds: ReadonlySet<number>,
  paneId: number
): Set<number> {
  if (paneIds.has(paneId)) {
    return paneIds instanceof Set ? paneIds : new Set(paneIds)
  }
  return new Set(paneIds).add(paneId)
}

export function removeSessionRestoredBannerPaneId(
  paneIds: ReadonlySet<number>,
  paneId: number
): Set<number> {
  if (!paneIds.has(paneId)) {
    return paneIds instanceof Set ? paneIds : new Set(paneIds)
  }
  const next = new Set(paneIds)
  next.delete(paneId)
  return next
}

export function pruneSessionRestoredBannerPaneIds(
  paneIds: ReadonlySet<number>,
  panes: readonly SessionRestoredBannerPane[]
): Set<number> {
  const livePaneIds = new Set(panes.map((pane) => pane.id))
  if ([...paneIds].every((paneId) => livePaneIds.has(paneId))) {
    return paneIds instanceof Set ? paneIds : new Set(paneIds)
  }
  return new Set([...paneIds].filter((paneId) => livePaneIds.has(paneId)))
}

export function getSessionRestoredBannerDismissPaneId(
  event: SessionRestoredBannerDismissEvent,
  panes: readonly SessionRestoredBannerPane[]
): number | null {
  const targetElement =
    event.target instanceof Element
      ? event.target
      : event.target instanceof Node
        ? event.target.parentElement
        : null
  const paneElement = targetElement?.closest('.pane[data-leaf-id]')
  if (!paneElement) {
    return null
  }
  return panes.find((pane) => pane.container === paneElement)?.id ?? null
}

export function dismissSessionRestoredBannerPaneIds(
  paneIds: ReadonlySet<number>,
  event: SessionRestoredBannerDismissEvent,
  panes: readonly SessionRestoredBannerPane[]
): Set<number> {
  const paneId = getSessionRestoredBannerDismissPaneId(event, panes)
  if (paneId === null) {
    return new Set()
  }
  return removeSessionRestoredBannerPaneId(paneIds, paneId)
}

export function seedStartupSessionRestoredBanner(
  startup: SessionRestoredBannerStartup,
  paneId: number,
  onShowSessionRestoredBanner: (paneId: number) => void
): void {
  if (startup?.showSessionRestoredBanner === true) {
    onShowSessionRestoredBanner(paneId)
  }
}

export function syncSessionRestoredBannerTitleSpace(args: {
  panes: readonly SessionRestoredBannerPane[]
  paneTitles: Readonly<Record<number, string>>
  renamingPaneId: number | null
  sessionRestoredBannerPaneIds: ReadonlySet<number>
  reservePaneHeaderSpace?: boolean
}): boolean {
  let needsFit = false
  for (const pane of args.panes) {
    const shouldShow =
      args.reservePaneHeaderSpace === true ||
      !!args.paneTitles[pane.id] ||
      args.renamingPaneId === pane.id ||
      args.sessionRestoredBannerPaneIds.has(pane.id)
    const hadTitle = pane.container.hasAttribute('data-has-title')
    if (shouldShow && !hadTitle) {
      pane.container.setAttribute('data-has-title', '')
      needsFit = true
    } else if (!shouldShow && hadTitle) {
      pane.container.removeAttribute('data-has-title')
      needsFit = true
    }
  }
  return needsFit
}

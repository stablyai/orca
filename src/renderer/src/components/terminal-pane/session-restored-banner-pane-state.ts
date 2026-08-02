import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

export type SessionRestoredBannerPane = Pick<ManagedPane, 'id' | 'container'>

/** `resume-unavailable`: the pane asked to resume a provider session Orca could not
 *  verify, so it launched a fresh one — silence would read as a successful restore. */
export type SessionRestoredBannerReason = 'restored' | 'resume-unavailable'

export type SessionRestoredBannerPaneReasons = ReadonlyMap<number, SessionRestoredBannerReason>

export type SessionRestoredBannerStartup =
  | {
      showSessionRestoredBanner?: boolean
    }
  | null
  | undefined

export type SessionRestoredBannerDismissEvent = KeyboardEvent | PointerEvent

export function addSessionRestoredBannerPaneId(
  paneReasons: SessionRestoredBannerPaneReasons,
  paneId: number,
  reason: SessionRestoredBannerReason = 'restored'
): Map<number, SessionRestoredBannerReason> {
  if (paneReasons.get(paneId) === reason) {
    return paneReasons instanceof Map ? paneReasons : new Map(paneReasons)
  }
  return new Map(paneReasons).set(paneId, reason)
}

export function removeSessionRestoredBannerPaneId(
  paneReasons: SessionRestoredBannerPaneReasons,
  paneId: number
): Map<number, SessionRestoredBannerReason> {
  if (!paneReasons.has(paneId)) {
    return paneReasons instanceof Map ? paneReasons : new Map(paneReasons)
  }
  const next = new Map(paneReasons)
  next.delete(paneId)
  return next
}

export function pruneSessionRestoredBannerPaneIds(
  paneReasons: SessionRestoredBannerPaneReasons,
  panes: readonly SessionRestoredBannerPane[]
): Map<number, SessionRestoredBannerReason> {
  const livePaneIds = new Set(panes.map((pane) => pane.id))
  if ([...paneReasons.keys()].every((paneId) => livePaneIds.has(paneId))) {
    return paneReasons instanceof Map ? paneReasons : new Map(paneReasons)
  }
  return new Map([...paneReasons].filter(([paneId]) => livePaneIds.has(paneId)))
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
  paneReasons: SessionRestoredBannerPaneReasons,
  event: SessionRestoredBannerDismissEvent,
  panes: readonly SessionRestoredBannerPane[]
): Map<number, SessionRestoredBannerReason> {
  const paneId = getSessionRestoredBannerDismissPaneId(event, panes)
  if (paneId === null) {
    return new Map()
  }
  return removeSessionRestoredBannerPaneId(paneReasons, paneId)
}

export function seedStartupSessionRestoredBanner(
  startup: SessionRestoredBannerStartup,
  paneId: number,
  onShowSessionRestoredBanner: (paneId: number, reason?: SessionRestoredBannerReason) => void
): void {
  if (startup?.showSessionRestoredBanner === true) {
    onShowSessionRestoredBanner(paneId)
  }
}

export function syncSessionRestoredBannerTitleSpace(args: {
  panes: readonly SessionRestoredBannerPane[]
  paneTitles: Readonly<Record<number, string>>
  renamingPaneId: number | null
  sessionRestoredBannerPaneIds: SessionRestoredBannerPaneReasons
}): boolean {
  let needsFit = false
  for (const pane of args.panes) {
    const shouldShow =
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

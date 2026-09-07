import {
  hydrateBrowserDrivers,
  setDriverForBrowserPage
} from '@/lib/pane-manager/browser-mobile-driver-state'
import {
  hydrateBrowserRemoteViewerPages,
  setRemoteViewersForBrowserPage
} from '@/lib/pane-manager/browser-remote-viewer-state'
import {
  applyClientHostedBrowserRows,
  hydrateClientHostedBrowserRows
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import type { ClientHostedBrowserRowsEvent } from '../../../../shared/client-hosted-browser-rows'
import { setDriverForPty, hydrateDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { setFitOverride, hydrateOverrides } from '@/lib/pane-manager/mobile-fit-overrides'
import { applyNativeChatLaunchDraftResolved } from '@/runtime/native-chat-launch-draft-runtime-resolution'
import type {
  RuntimeBrowserDriverState,
  RuntimeTerminalDriverState
} from '../../../../shared/runtime-types'
import { useAppStore } from '../../store'

const MAX_PENDING_MOBILE_STATE_EVENTS = 300

type PendingMobileStateEvent =
  | {
      kind: 'fit'
      event: {
        ptyId: string
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }
    }
  | { kind: 'driver'; event: { ptyId: string; driver: RuntimeTerminalDriverState } }
  | {
      kind: 'browser-driver'
      event: { browserPageId: string; driver: RuntimeBrowserDriverState }
    }
  | {
      kind: 'browser-remote-viewers'
      event: { browserPageId: string; hasRemoteViewers: boolean }
    }

export function registerMobileDriverIpcBridge(
  unsubs: (() => void)[],
  isRuntimeEnvironmentActive: () => boolean
): () => void {
  let mobileStateHydrated = isRuntimeEnvironmentActive()
  const pendingMobileStateEvents: PendingMobileStateEvent[] = []
  let disposed = false

  const applyPendingMobileStateEvents = (): void => {
    for (const pending of pendingMobileStateEvents) {
      if (pending.kind === 'fit') {
        const { ptyId, mode, cols, rows } = pending.event
        setFitOverride(ptyId, mode, cols, rows)
      } else if (pending.kind === 'driver') {
        setDriverForPty(pending.event.ptyId, pending.event.driver)
      } else if (pending.kind === 'browser-driver') {
        setDriverForBrowserPage(pending.event.browserPageId, pending.event.driver)
      } else {
        setRemoteViewersForBrowserPage(pending.event.browserPageId, pending.event.hasRemoteViewers)
      }
    }
    pendingMobileStateEvents.length = 0
  }
  const enqueue = (event: PendingMobileStateEvent): void => {
    pendingMobileStateEvents.push(event)
    while (pendingMobileStateEvents.length > MAX_PENDING_MOBILE_STATE_EVENTS) {
      pendingMobileStateEvents.shift()
    }
  }

  unsubs.push(
    window.api.runtime.onTerminalFitOverrideChanged((event) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      if (!mobileStateHydrated) {
        enqueue({ kind: 'fit', event })
        return
      }
      setFitOverride(event.ptyId, event.mode, event.cols, event.rows)
    })
  )
  unsubs.push(
    window.api.runtime.onTerminalDriverChanged((event) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      if (!mobileStateHydrated) {
        enqueue({ kind: 'driver', event })
        return
      }
      setDriverForPty(event.ptyId, event.driver)
    })
  )
  const unsubscribeLaunchDraftResolution = window.api.runtime.onNativeChatLaunchDraftResolved?.(
    (event) => {
      applyNativeChatLaunchDraftResolved(useAppStore.getState(), {
        type: 'nativeChatLaunchDraftResolved',
        ...event
      })
    }
  )
  if (unsubscribeLaunchDraftResolution) {
    unsubs.push(unsubscribeLaunchDraftResolution)
  }
  unsubs.push(
    window.api.runtime.onBrowserDriverChanged((event) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      if (!mobileStateHydrated) {
        enqueue({ kind: 'browser-driver', event })
        return
      }
      setDriverForBrowserPage(event.browserPageId, event.driver)
    })
  )

  const unsubscribeBrowserRemoteViewers = window.api.runtime.onBrowserRemoteViewersChanged?.(
    (event) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      if (!mobileStateHydrated) {
        enqueue({ kind: 'browser-remote-viewers', event })
        return
      }
      setRemoteViewersForBrowserPage(event.browserPageId, event.hasRemoteViewers)
    }
  )
  if (unsubscribeBrowserRemoteViewers) {
    unsubs.push(unsubscribeBrowserRemoteViewers)
  }

  // Why: no isRuntimeEnvironmentActive guard, unlike the driver channels above. These rows
  // describe pages a paired client renders for THIS runtime's own worktrees; pointing the window
  // at a remote environment does not make them someone else's, and dropping them would leave the
  // host with an uncloseable page it cannot see. Hydration below is unguarded for the same reason.
  let clientHostedRowsHydrated = false
  const pendingClientHostedRowEvents: ClientHostedBrowserRowsEvent[] = []
  const settleClientHostedRowHydration = (): void => {
    clientHostedRowsHydrated = true
    for (const event of pendingClientHostedRowEvents) {
      applyClientHostedBrowserRows(event)
    }
    pendingClientHostedRowEvents.length = 0
  }
  unsubs.push(
    window.api.runtime.onClientHostedBrowserRowsChanged((event) => {
      // Why: subscribe before the snapshot round trip and buffer, or the older snapshot
      // overwrites a page created while it was in flight.
      if (!clientHostedRowsHydrated) {
        pendingClientHostedRowEvents.push(event)
        while (pendingClientHostedRowEvents.length > MAX_PENDING_MOBILE_STATE_EVENTS) {
          pendingClientHostedRowEvents.shift()
        }
        return
      }
      applyClientHostedBrowserRows(event)
    })
  )
  void window.api.runtime
    .getClientHostedBrowserRows()
    .then((events) => {
      if (disposed) {
        return
      }
      hydrateClientHostedBrowserRows(events)
      settleClientHostedRowHydration()
    })
    .catch((error: unknown) => {
      if (disposed) {
        return
      }
      console.error('Failed to hydrate client-hosted browser rows:', error)
      settleClientHostedRowHydration()
    })

  // Subscribe before snapshots; queued pushes replay in arrival order after all three hydrate.
  if (!isRuntimeEnvironmentActive()) {
    void Promise.all([
      window.api.runtime.getTerminalFitOverrides(),
      window.api.runtime.getTerminalDrivers(),
      window.api.runtime.getBrowserDrivers(),
      window.api.runtime.getBrowserRemoteViewerPages?.() ?? []
    ])
      .then(([overrides, drivers, browserDrivers, remoteViewerPages]) => {
        if (disposed) {
          return
        }
        hydrateOverrides(overrides)
        hydrateDrivers(drivers)
        hydrateBrowserDrivers(browserDrivers)
        hydrateBrowserRemoteViewerPages(remoteViewerPages)
        mobileStateHydrated = true
        applyPendingMobileStateEvents()
      })
      .catch((error: unknown) => {
        if (disposed) {
          return
        }
        console.error('Failed to hydrate mobile terminal state:', error)
        mobileStateHydrated = true
        applyPendingMobileStateEvents()
      })
  }

  return () => {
    disposed = true
    pendingMobileStateEvents.length = 0
    pendingClientHostedRowEvents.length = 0
  }
}

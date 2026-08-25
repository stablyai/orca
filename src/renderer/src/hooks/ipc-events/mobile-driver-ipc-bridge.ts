import {
  hydrateBrowserDrivers,
  setDriverForBrowserPage
} from '@/lib/pane-manager/browser-mobile-driver-state'
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
      } else {
        setDriverForBrowserPage(pending.event.browserPageId, pending.event.driver)
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

  // Subscribe before snapshots; queued pushes replay in arrival order after all three hydrate.
  if (!isRuntimeEnvironmentActive()) {
    void Promise.all([
      window.api.runtime.getTerminalFitOverrides(),
      window.api.runtime.getTerminalDrivers(),
      window.api.runtime.getBrowserDrivers()
    ])
      .then(([overrides, drivers, browserDrivers]) => {
        if (disposed) {
          return
        }
        hydrateOverrides(overrides)
        hydrateDrivers(drivers)
        hydrateBrowserDrivers(browserDrivers)
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
  }
}

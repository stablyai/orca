import type { RuntimeBrowserDriverState } from '../../../../shared/runtime-types'

export type BrowserDriverState = RuntimeBrowserDriverState

const driverByBrowserPageId = new Map<string, BrowserDriverState>()

type BrowserDriverChangeEvent = {
  browserPageId: string
  driver: BrowserDriverState
}

type BrowserDriverChangeListener = (event: BrowserDriverChangeEvent) => void
const changeListeners = new Set<BrowserDriverChangeListener>()

export function onBrowserDriverChange(listener: BrowserDriverChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChange(event: BrowserDriverChangeEvent): void {
  for (const listener of changeListeners) {
    listener(event)
  }
}

export function setDriverForBrowserPage(browserPageId: string, driver: BrowserDriverState): void {
  if (driver.kind === 'idle') {
    driverByBrowserPageId.delete(browserPageId)
  } else {
    driverByBrowserPageId.set(browserPageId, driver)
  }
  notifyChange({ browserPageId, driver })
}

export function getDriverForBrowserPage(browserPageId: string): BrowserDriverState {
  return driverByBrowserPageId.get(browserPageId) ?? { kind: 'idle' }
}

export function hydrateBrowserDrivers(
  drivers: { browserPageId: string; driver: BrowserDriverState }[]
): void {
  const affectedPageIds = new Set(driverByBrowserPageId.keys())
  driverByBrowserPageId.clear()

  for (const { browserPageId, driver } of drivers) {
    affectedPageIds.add(browserPageId)
    if (driver.kind !== 'idle') {
      driverByBrowserPageId.set(browserPageId, driver)
    }
  }

  // Why: browser panes can mount before IPC hydration returns after reload.
  // Notify all known pages so a stale desktop input surface cannot stay active.
  for (const browserPageId of affectedPageIds) {
    notifyChange({ browserPageId, driver: getDriverForBrowserPage(browserPageId) })
  }
}

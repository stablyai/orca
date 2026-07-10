import { useSyncExternalStore } from 'react'
import type { RuntimeBrowserDriverState } from '../../../../shared/runtime-types'

export type BrowserDriverState = RuntimeBrowserDriverState

const driverByBrowserPageId = new Map<string, BrowserDriverState>()

type BrowserDriverChangeEvent = {
  browserPageId: string
  driver: BrowserDriverState
}

type BrowserDriverChangeListener = (event: BrowserDriverChangeEvent) => void
const changeListeners = new Set<BrowserDriverChangeListener>()
const snapshotListeners = new Set<() => void>()
let version = 0

export function onBrowserDriverChange(listener: BrowserDriverChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function subscribe(listener: () => void): () => void {
  snapshotListeners.add(listener)
  return () => {
    snapshotListeners.delete(listener)
  }
}

function getSnapshot(): number {
  return version
}

function getServerSnapshot(): number {
  return 0
}

function notifyChange(event: BrowserDriverChangeEvent): void {
  version += 1
  for (const listener of changeListeners) {
    listener(event)
  }
  for (const listener of snapshotListeners) {
    listener()
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

export function isBrowserPageMobileDriven(browserPageId: string): boolean {
  return driverByBrowserPageId.get(browserPageId)?.kind === 'mobile'
}

export function hasMobileDriverForAnyBrowserPage(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  return browserPageIds.some((pageId) => Boolean(pageId && isBrowserPageMobileDriven(pageId)))
}

export function getBrowserMobileDrivenPageIds(
  browserPageIds: readonly (string | null | undefined)[]
): Set<string> {
  const mobileDrivenPageIds = new Set<string>()
  for (const pageId of browserPageIds) {
    if (pageId && isBrowserPageMobileDriven(pageId)) {
      mobileDrivenPageIds.add(pageId)
    }
  }
  return mobileDrivenPageIds
}

export function useBrowserMobileDriverForAny(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return hasMobileDriverForAnyBrowserPage(browserPageIds)
}

export function useBrowserMobileDrivenPageIds(
  browserPageIds: readonly (string | null | undefined)[]
): Set<string> {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return getBrowserMobileDrivenPageIds(browserPageIds)
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

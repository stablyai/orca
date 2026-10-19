import { useSyncExternalStore } from 'react'
import type { BrowserAutomationActivityEvent } from '../../../shared/browser-automation-activity'

const MAX_REMEMBERED_PAGES = 128
const MAX_LEASE_MS = 60_000
const leases = new Map<string, { browserPageId: string; timer: ReturnType<typeof setTimeout> }>()
const leaseCounts = new Map<string, number>()
const listeners = new Set<() => void>()
let pageIds: readonly string[] = []
let version = 0

function emitChange(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getVersion(): number {
  return version
}

function rememberPage(browserPageId: string): boolean {
  if (pageIds.includes(browserPageId)) {
    return false
  }
  pageIds = [...pageIds.slice(-(MAX_REMEMBERED_PAGES - 1)), browserPageId]
  return true
}

export function rememberAutomationBrowserPage(browserPageId: string): void {
  if (browserPageId && rememberPage(browserPageId)) {
    emitChange()
  }
}

function releaseLease(token: string): void {
  const lease = leases.get(token)
  if (!lease) {
    return
  }
  clearTimeout(lease.timer)
  leases.delete(token)
  const count = (leaseCounts.get(lease.browserPageId) ?? 1) - 1
  if (count > 0) {
    leaseCounts.set(lease.browserPageId, count)
    return
  }
  leaseCounts.delete(lease.browserPageId)
  emitChange()
}

export function applyBrowserAutomationActivity(event: BrowserAutomationActivityEvent): void {
  const { browserPageId, token, active, expiresAt } = event
  if (!browserPageId || !token || !Number.isFinite(expiresAt)) {
    return
  }
  const existing = leases.get(token)
  if (existing && existing.browserPageId !== browserPageId) {
    return
  }
  if (!active || expiresAt <= Date.now()) {
    releaseLease(token)
    return
  }
  if (existing) {
    clearTimeout(existing.timer)
  }
  const timer = setTimeout(
    () => releaseLease(token),
    Math.min(expiresAt - Date.now(), MAX_LEASE_MS)
  )
  leases.set(token, { browserPageId, timer })
  if (!existing) {
    const count = leaseCounts.get(browserPageId) ?? 0
    leaseCounts.set(browserPageId, count + 1)
    const addedPage = rememberPage(browserPageId)
    if (count === 0 || addedPage) {
      emitChange()
    }
  }
}

export function clearBrowserAutomationActivity(): void {
  if (leases.size === 0) {
    return
  }
  for (const { timer } of leases.values()) {
    clearTimeout(timer)
  }
  leases.clear()
  leaseCounts.clear()
  emitChange()
}

export function isBrowserAutomationActive(browserPageId: string | null | undefined): boolean {
  return Boolean(browserPageId && leaseCounts.has(browserPageId))
}

export function useBrowserAutomationActive(browserPageId: string | null | undefined): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return isBrowserAutomationActive(browserPageId)
}

export function useBrowserAutomationActiveForAny(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return browserPageIds.some(isBrowserAutomationActive)
}

export function useBrowserAutomationPageIds(): readonly string[] {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return pageIds
}

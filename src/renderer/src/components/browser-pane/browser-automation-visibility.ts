import { useSyncExternalStore } from 'react'

type BrowserAutomationVisibilityBridge = {
  acquire: (browserPageId: string) => Promise<string | null>
  release: (token: string) => boolean
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __orcaBrowserAutomationVisibility?: BrowserAutomationVisibilityBridge
  }
}

const leaseCountsByPageId = new Map<string, number>()
const pageIdByToken = new Map<string, string>()
const listeners = new Set<() => void>()

let version = 0
let nextLeaseId = 0

function emitChange(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): number {
  return version
}

function getServerSnapshot(): number {
  return 0
}

function nextAnimationFrame(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve()
  }
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}

export function isBrowserAutomationVisible(browserPageId: string): boolean {
  return (leaseCountsByPageId.get(browserPageId) ?? 0) > 0
}

export function useBrowserAutomationVisibility(browserPageId: string | null | undefined): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return Boolean(browserPageId && isBrowserAutomationVisible(browserPageId))
}

export function useBrowserAutomationVisibilityForAny(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return browserPageIds.some((pageId) => Boolean(pageId && isBrowserAutomationVisible(pageId)))
}

export function getBrowserAutomationVisiblePageIds(browserPageIds: readonly string[]): Set<string> {
  const visible = new Set<string>()
  for (const pageId of browserPageIds) {
    if (isBrowserAutomationVisible(pageId)) {
      visible.add(pageId)
    }
  }
  return visible
}

export function useBrowserAutomationVisiblePageIds(browserPageIds: readonly string[]): Set<string> {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return getBrowserAutomationVisiblePageIds(browserPageIds)
}

export function acquireBrowserAutomationVisibility(browserPageId: string): string {
  const token = `browser-automation-${Date.now()}-${++nextLeaseId}`
  pageIdByToken.set(token, browserPageId)
  leaseCountsByPageId.set(browserPageId, (leaseCountsByPageId.get(browserPageId) ?? 0) + 1)
  emitChange()
  return token
}

export function releaseBrowserAutomationVisibility(token: string): boolean {
  const browserPageId = pageIdByToken.get(token)
  if (!browserPageId) {
    return false
  }
  pageIdByToken.delete(token)
  const nextCount = (leaseCountsByPageId.get(browserPageId) ?? 1) - 1
  if (nextCount > 0) {
    leaseCountsByPageId.set(browserPageId, nextCount)
  } else {
    leaseCountsByPageId.delete(browserPageId)
  }
  emitChange()
  return true
}

async function acquireForMainProcess(browserPageId: string): Promise<string | null> {
  if (typeof browserPageId !== 'string' || browserPageId.length === 0) {
    return null
  }
  // Why: only allocate the lease after the paint wait succeeds. If RAF hangs,
  // main times out without leaving a permanently visible hidden webview.
  await nextAnimationFrame()
  await nextAnimationFrame()
  return acquireBrowserAutomationVisibility(browserPageId)
}

export function installBrowserAutomationVisibilityBridge(): void {
  if (typeof window === 'undefined') {
    return
  }
  window.__orcaBrowserAutomationVisibility = {
    acquire: acquireForMainProcess,
    release: releaseBrowserAutomationVisibility
  }
}

installBrowserAutomationVisibilityBridge()

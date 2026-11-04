import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import {
  isBrowserPageMobileDriven,
  onBrowserDriverChange,
  useBrowserMobileDriverForAny
} from '../../../lib/pane-manager/browser-mobile-driver-state'
import {
  isBrowserPageRemotelyViewed,
  onBrowserRemoteViewerChange,
  useBrowserRemoteViewerForAny
} from '../../../lib/pane-manager/browser-remote-viewer-state'
import {
  isBrowserAutomationVisible,
  onBrowserAutomationVisibilityChange,
  useBrowserAutomationVisibilityForAny
} from './browser-automation-visibility'

// Every ancestor must avoid display:none for retained guests; a pane cannot override hidden parents to keep mobile/agent/paired screencasts producing frames.

type BrowserTabPageIdSource = {
  id: string
  activePageId?: string | null
  pageIds?: readonly string[] | null
}

// Why: a stable identity keeps the disabled branch from re-running downstream shallow compares.
const NO_BROWSER_PAGE_IDS: readonly string[] = []

export function collectBrowserPageIds(
  tabs: readonly BrowserTabPageIdSource[] | null | undefined
): readonly string[] {
  // Why the early return: no browser tabs is the common case, and this runs on every store write.
  if (!tabs || tabs.length === 0) {
    return NO_BROWSER_PAGE_IDS
  }
  return tabs.flatMap((tab) =>
    tab.pageIds && tab.pageIds.length > 0 ? tab.pageIds : [tab.activePageId ?? tab.id]
  )
}
const NO_BROWSER_TABS_BY_WORKTREE: Record<string, BrowserTabPageIdSource[]> = {}

export function useWorktreeBrowserPageIds(worktreeId: string): readonly string[] {
  return useAppStore(
    useShallow((state) => collectBrowserPageIds(state.browserTabsByWorktree[worktreeId]))
  )
}

export function useBrowserGuestPaintRetention(browserPageIds: readonly string[]): boolean {
  const hasAutomationVisibleBrowser = useBrowserAutomationVisibilityForAny(browserPageIds)
  const hasMobileDrivenBrowser = useBrowserMobileDriverForAny(browserPageIds)
  const hasRemotelyViewedBrowser = useBrowserRemoteViewerForAny(browserPageIds)
  return hasAutomationVisibleBrowser || hasMobileDrivenBrowser || hasRemotelyViewedBrowser
}

// Centralize all paint-retention terms so new signals cannot silently miss a container gate.
export function browserPageNeedsPaintRetention(browserPageId: string): boolean {
  return (
    isBrowserAutomationVisible(browserPageId) ||
    isBrowserPageMobileDriven(browserPageId) ||
    isBrowserPageRemotelyViewed(browserPageId)
  )
}

/** Fires whenever any retention term flips, for callers that cache a retention decision. */
export function onBrowserGuestPaintRetentionChange(listener: () => void): () => void {
  const removeListeners = [
    onBrowserAutomationVisibilityChange(listener),
    onBrowserDriverChange(listener),
    onBrowserRemoteViewerChange(listener)
  ]
  return () => {
    for (const removeListener of removeListeners) {
      removeListener()
    }
  }
}

// Scan only for hidden callers. Include automation bootstrap: mobile driving starts after guest registration, so driver-only gating would deadlock a cold phone screencast.
export function useAnyBrowserGuestNeedsPaint(enabled: boolean): boolean {
  const browserTabsByWorktree = useAppStore((state) =>
    enabled ? state.browserTabsByWorktree : NO_BROWSER_TABS_BY_WORKTREE
  )
  const browserPageIds = useMemo(
    () =>
      enabled
        ? Object.values(browserTabsByWorktree).flatMap((tabs) => collectBrowserPageIds(tabs))
        : NO_BROWSER_PAGE_IDS,
    [browserTabsByWorktree, enabled]
  )
  return useBrowserGuestPaintRetention(browserPageIds)
}

import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import { useBrowserMobileDriverForAny } from '../../../lib/pane-manager/browser-mobile-driver-state'
import { useBrowserAutomationVisibilityForAny } from './browser-automation-visibility'

// Why: Chromium never paints inside a display:none subtree, so a browser <webview> stops
// emitting screencast frames if ANY ancestor is parked that way — the pane-level hatch in
// browser-page-paintability.ts cannot override one. Every container from the app shell down
// to the guest therefore shares this predicate; if one of them keeps using `hidden`, a phone
// or an agent driving that page silently receives no frames.

type BrowserTabPageIdSource = {
  id: string
  activePageId?: string | null
  pageIds?: readonly string[] | null
}

export function collectBrowserPageIds(
  tabs: readonly BrowserTabPageIdSource[] | null | undefined
): string[] {
  return (tabs ?? []).flatMap((tab) =>
    tab.pageIds && tab.pageIds.length > 0 ? tab.pageIds : [tab.activePageId ?? tab.id]
  )
}

// Why: a stable identity keeps the disabled branch from re-running downstream shallow compares.
const NO_BROWSER_PAGE_IDS: string[] = []
const NO_BROWSER_TABS_BY_WORKTREE: Record<string, BrowserTabPageIdSource[]> = {}

export function useWorktreeBrowserPageIds(worktreeId: string): string[] {
  return useAppStore(
    useShallow((state) => collectBrowserPageIds(state.browserTabsByWorktree[worktreeId]))
  )
}

export function useBrowserGuestPaintRetention(browserPageIds: readonly string[]): boolean {
  const hasAutomationVisibleBrowser = useBrowserAutomationVisibilityForAny(browserPageIds)
  const hasMobileDrivenBrowser = useBrowserMobileDriverForAny(browserPageIds)
  return hasAutomationVisibleBrowser || hasMobileDrivenBrowser
}

// Why: `enabled` gates a scan across every worktree's tabs, which only matters while the
// caller is hidden. Automation visibility is load-bearing and not just symmetry with the
// per-worktree gate: a cold screencast cannot start without it. Main asks the renderer to
// mount a hidden guest via browser:activateView, which takes an automation bootstrap lease —
// and the mobile driver flag only flips AFTER that guest registers and streaming begins. Gate
// on the driver alone and the guest never mounts, so the driver never flips: a deadlock that
// leaves the page unreachable from the phone entirely.
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

import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { findPage } from '@/store/slices/browser-page-records'
import {
  buildOpenTabSearchBrowserPages,
  selectOpenTabSearchBrowserPageState
} from '@/components/tab-bar/open-tab-search-entries'
import {
  activateBrowserPagePaletteResult,
  type BrowserPagePaletteActivationTarget
} from '@/lib/browser-page-palette-activation'
import { isBlankBrowserUrl } from '@/lib/browser-palette-search'
import { normalizeBrowserNavigationUrl } from '../../../../../shared/browser-url'
import { requestBrowserFocus } from '../host-guest/browser-focus'
import { toDisplayUrl } from '../describe-page/browser-page-url-display'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'

type SwitchableRow = Pick<BrowserAddressBarSuggestion, 'url' | 'isSearch' | 'docLocation'>

// Why not the history key: it drops any final "/", which can be part of a path or query value.
function pageKey(url: string): string {
  return normalizeBrowserNavigationUrl(url) ?? url
}

/** Activate matching pages within this worktree/host; Tab and Enter target the row’s button while DOM focus stays in the input. */
export function useBrowserAddressBarSwitchToTab({
  pageId,
  open,
  dismissSuggestions,
  onChange,
  onNavigate
}: {
  pageId: string
  open: boolean
  dismissSuggestions: () => void
  onChange: (value: string) => void
  onNavigate: (url: string) => void
}): {
  hasSwitchTarget: (row: SwitchableRow) => boolean
  /** Virtual button focus; DOM focus remains in the input. */
  focusedUrl: string | null
  /** Tab onto the selected row's button or Shift+Tab off it; true when it took the key. */
  handleTabKey: (event: KeyboardEvent<HTMLInputElement>, selectedRow?: SwitchableRow) => boolean
  clearFocus: () => void
  switchToTab: (url: string) => void
} {
  const [focusedUrl, setFocusedUrl] = useState<string | null>(null)
  const [wasOpen, setWasOpen] = useState(open)
  // Reset closed-list button focus during render so reopening cannot leave Enter aimed at an abandoned target.
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) {
      setFocusedUrl(null)
    }
  }
  // Why only while open: the scan follows every page update, which a closed bar never needs.
  const entryState = useAppStore(
    useShallow((state) => {
      if (!open) {
        return null
      }
      const page = findPage(state.browserPagesByWorkspace, pageId)
      return page ? selectOpenTabSearchBrowserPageState(state, page.worktreeId) : null
    })
  )

  const targets = useMemo(() => {
    const byUrl = new Map<string, BrowserPagePaletteActivationTarget>()
    if (!entryState) {
      return byUrl
    }
    for (const entry of buildOpenTabSearchBrowserPages(entryState)) {
      const key = pageKey(entry.page.url)
      if (entry.page.id === pageId || isBlankBrowserUrl(entry.page.url) || byUrl.has(key)) {
        continue
      }
      byUrl.set(key, {
        executionHostId: entry.executionHostId,
        pageId: entry.page.id,
        workspaceId: entry.workspace.id,
        worktreeId: entry.worktree.id
      })
    }
    return byUrl
  }, [entryState, pageId])

  const targetFor = useCallback(
    (row: SwitchableRow) =>
      row.isSearch || row.docLocation ? undefined : targets.get(pageKey(row.url)),
    [targets]
  )

  const handleTabKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, selectedRow?: SwitchableRow): boolean => {
      if (event.key !== 'Tab' || !selectedRow || !targetFor(selectedRow)) {
        return false
      }
      const focused = focusedUrl === selectedRow.url
      if (event.shiftKey !== focused) {
        return false
      }
      event.preventDefault()
      setFocusedUrl(focused ? null : selectedRow.url)
      return true
    },
    [focusedUrl, targetFor]
  )

  const switchToTab = useCallback(
    (url: string): void => {
      setFocusedUrl(null)
      const target = targetFor({ url, isSearch: false })
      if (!target) {
        return
      }
      dismissSuggestions()
      const activation = activateBrowserPagePaletteResult(target)
      if (activation.status === 'failed') {
        // Why: the tab closed after the list was drawn; the user still asked for the page.
        onNavigate(url)
        return
      }
      if (activation.status === 'activated') {
        // Why: like Chrome, the tab you switched away from shows its own page again.
        const page = findPage(useAppStore.getState().browserPagesByWorkspace, pageId)
        onChange(toDisplayUrl(page?.url ?? ''))
        requestBrowserFocus({ pageId: activation.pageId, target: activation.focusTarget })
      }
    },
    [dismissSuggestions, onChange, onNavigate, pageId, targetFor]
  )

  // Why: a focused button whose tab has since closed or moved on no longer takes Enter.
  const liveFocusedUrl =
    focusedUrl !== null && targetFor({ url: focusedUrl, isSearch: false }) ? focusedUrl : null

  return useMemo(
    () => ({
      hasSwitchTarget: (row: SwitchableRow) => targetFor(row) !== undefined,
      focusedUrl: liveFocusedUrl,
      handleTabKey,
      clearFocus: () => setFocusedUrl(null),
      switchToTab
    }),
    [handleTabKey, liveFocusedUrl, switchToTab, targetFor]
  )
}

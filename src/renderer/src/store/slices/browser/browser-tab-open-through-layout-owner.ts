import {
  beginDesktopNavigation,
  canPresentDesktopNavigation,
  navigateDesktopTab
} from '@/lib/desktop-navigation-request'
// Propose browser tab/record/page IDs to main; select only after frame draws them with window page state. Record consumers wait through afterPendingTab.

import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { openContentTabThroughLayoutOwner } from '@/runtime/layout-owner-content-tab-open'
import { contentTabOpenPlacement } from '../tabs/content-tab-open-placement'
import type { BrowserSliceGet, CreateBrowserTabOptions } from './browser-slice-contract'

type BrowserTabOpen = {
  worktreeId: string
  browserTab: BrowserWorkspace
  page: BrowserPage
  options: CreateBrowserTabOptions | undefined
  /** The window's own view of the tab, written once main's frame drew it. */
  showView: (activate: boolean) => void
  /** Today's draw, for a twin main may route to a paired server. */
  drawHere: () => void
}

/** False when main is not asked (a paired server owns the workspace's layout): draw as today. */
export function openBrowserTabThroughLayoutOwner(
  get: BrowserSliceGet,
  open: BrowserTabOpen
): boolean {
  const { worktreeId, browserTab, page, options } = open
  const request =
    options?.navigation === undefined
      ? options?.activate === false
        ? null
        : beginDesktopNavigation(get())
      : options.navigation
  const state = get()
  const tabId = createBrowserUuid()
  const placement = contentTabOpenPlacement(state, worktreeId, tabId, {
    targetGroupId: options?.targetGroupId,
    afterTabId: options?.afterTabId,
    split: options?.split,
    executionHostId: options?.executionHostId
  })
  if (!placement) {
    return false
  }
  const activate = options?.activate ?? true
  return openContentTabThroughLayoutOwner(state, {
    worktreeId,
    entityId: browserTab.id,
    command: {
      type: 'openBrowserTab',
      tabId,
      browserTabId: browserTab.id,
      pageId: page.id,
      profileId: browserTab.sessionProfileId ?? null,
      sessionPartition: browserTab.sessionPartition ?? null,
      ...placement
    },
    facts: { label: browserTab.title, browser: { record: browserTab, pages: [page] } },
    shown: (shownId) => {
      const foreground = activate && !!request && canPresentDesktopNavigation(request)
      open.showView(foreground)
      if (!foreground) {
        return
      }
      navigateDesktopTab(get(), shownId, { worktreeId, request: request!, scope: 'workspace' })
      const groupId = get().unifiedTabsByWorktree[worktreeId]?.find(
        (t) => t.id === shownId
      )?.groupId
      if (groupId) {
        get().focusGroup(worktreeId, groupId)
      }
    },
    drawHere: () => {
      open.drawHere()
      return (
        get().unifiedTabsByWorktree[worktreeId]?.find(
          (t) => t.contentType === 'browser' && t.entityId === browserTab.id
        )?.id ?? null
      )
    }
  })
}

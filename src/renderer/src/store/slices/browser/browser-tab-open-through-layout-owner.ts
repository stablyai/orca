// A browser tab open in a layout-owner build: the window proposes the tab-bar entry, record and
// page ids and sends the open; main's frame draws the tab with the window's page state, and only
// then does the window select it. A caller acting on the record waits with `afterPendingTab`.

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
  showView: () => void
  /** Today's draw, for a twin main may route to a paired server. */
  drawHere: () => void
}

/** False when main is not asked (a paired server owns the workspace's layout): draw as today. */
export function openBrowserTabThroughLayoutOwner(
  get: BrowserSliceGet,
  open: BrowserTabOpen
): boolean {
  const { worktreeId, browserTab, page, options } = open
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
      open.showView()
      if (!activate) {
        return
      }
      get().activateTab(shownId, { worktreeId })
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

import type { Translate } from '@/i18n/use-translate'
import { searchBrowserPages } from '@/lib/browser/palette/browser-palette-search'
import { searchSimulatorTabs } from '@/lib/simulator/search/simulator-palette-search'
import { searchWorkspaceTabs } from '@/lib/workspace/search/tabs/workspace-tab-palette-results'
import type { OpenTabPaletteItem } from '@/components/worktree-jump/worktree-jump-palette-model'
import {
  buildBrowserPaletteItems,
  buildOpenTabPaletteItems,
  buildSimulatorPaletteItems,
  buildWorkspaceTabPaletteItems
} from '@/components/worktree-jump/tabs/worktree-jump-palette-open-tab-items'
import type { PaletteSearchContext } from '../../../../../shared/palette-match/palette-ranking'
import {
  tabSearchBrowserFocusKey,
  tabSearchFocusKey,
  type TabSearchIndex
} from './tab-search-index'

export type TabRecency = { isCurrent: boolean; lastFocusedAt: number | null }

/**
 * Chrome Tab Search's empty-query order (chrome/browser/resources/tab_search/tab_search_page.ts,
 * BSD-licensed, The Chromium Authors): most recently focused first, the tab already on screen last
 * because nobody searches for it. Ties keep the input order.
 */
export function orderByTabRecency<T>(items: readonly T[], recencyOf: (item: T) => TabRecency): T[] {
  const ranked = items.map((item, index) => ({ item, index, ...recencyOf(item) }))
  ranked.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? 1 : -1
    }
    if (a.lastFocusedAt !== b.lastFocusedAt) {
      if (a.lastFocusedAt === null) {
        return 1
      }
      if (b.lastFocusedAt === null) {
        return -1
      }
      return b.lastFocusedAt - a.lastFocusedAt
    }
    return a.index - b.index
  })
  return ranked.map((entry) => entry.item)
}

function recencyOf(index: TabSearchIndex, item: OpenTabPaletteItem): TabRecency {
  if (item.type === 'browser-page') {
    const { worktreeId, workspaceId } = item.result
    return {
      isCurrent: item.result.isCurrentPage,
      lastFocusedAt:
        index.lastFocusedAt.get(tabSearchBrowserFocusKey(worktreeId, workspaceId)) ?? null
    }
  }
  return {
    isCurrent: item.result.isCurrentTab,
    lastFocusedAt:
      index.lastFocusedAt.get(tabSearchFocusKey(item.result.worktreeId, item.result.tabId)) ?? null
  }
}

/** A query ranks like Cmd+J's Open Tabs section; an empty one lists tabs the way Chrome does. */
export function searchTabSearchIndex(
  index: TabSearchIndex,
  query: string,
  context: PaletteSearchContext,
  t: Translate
): OpenTabPaletteItem[] {
  const trimmed = query.trim()
  const items = buildOpenTabPaletteItems({
    workspaceTabItems: buildWorkspaceTabPaletteItems(
      searchWorkspaceTabs(index.workspaceTabs, trimmed, { context })
    ),
    browserItems: buildBrowserPaletteItems(
      searchBrowserPages(index.browserPages, trimmed, { context })
    ),
    simulatorItems: buildSimulatorPaletteItems(
      searchSimulatorTabs(index.simulatorTabs, trimmed, { context }, t)
    )
  })
  return trimmed ? items : orderByTabRecency(items, (item) => recencyOf(index, item))
}

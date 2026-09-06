import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  buildExplicitEntriesByTabId,
  type TabPaneInputSources
} from '@/components/sidebar/smart-attention'
import {
  orderRecentWorkspaceTabs,
  type RecentWorkspaceTabRow
} from '@/lib/recent-workspace-tab-rows'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  EMPTY_RECENT_TAB_ORDER,
  type OpenTabRecentRow,
  type PaletteItem
} from './worktree-jump-palette-model'
import { shouldIncludeOpenTabInRecentSection } from './worktree-jump-palette-recent-inclusion'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteOpenTabs } from './use-worktree-jump-palette-open-tabs'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import {
  getPaletteWorktreeExecutionHostId,
  getPaletteWorktreeIdentity
} from '@/lib/palette-repo-resolution'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'

type WorktreeJumpPaletteRecentTabsInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteOpenTabs &
  Pick<WorktreeJumpPaletteWorktrees, 'resolveWorktree' | 'hasQuery'> &
  Pick<
    WorktreeJumpPaletteLocalState,
    'query' | 'filter' | 'autoSelectedItemIdRef' | 'setSelectedItemId'
  >

type RecentTabOrderSnapshot = {
  order: readonly string[]
  attentionReady: boolean
}

const EMPTY_RECENT_TAB_SNAPSHOT: RecentTabOrderSnapshot = {
  order: EMPTY_RECENT_TAB_ORDER,
  attentionReady: false
}

export function useWorktreeJumpPaletteRecentTabs({
  tabsByWorktree,
  agentStatusByPaneKey,
  migrationUnsupportedByPtyId,
  ptyIdsByTabId,
  runtimePaneTitlesByTabId,
  terminalLayoutsByTabId,
  openTabItems,
  workspaceTabEntries,
  simulatorTabEntries,
  browserPageEntries,
  resolveWorktree,
  unreadTerminalTabs,
  unreadAgentCompletionPanes,
  visible,
  hasQuery,
  query,
  filter,
  autoSelectedItemIdRef,
  setSelectedItemId
}: WorktreeJumpPaletteRecentTabsInput) {
  const tabFocusTimes = useMemo(() => {
    const times = new Map<string, number | undefined>()
    for (const entry of [...workspaceTabEntries, ...simulatorTabEntries]) {
      times.set(
        encodePaletteIdentity(['tab', getPaletteWorktreeIdentity(entry.worktree), entry.tab.id]),
        entry.tab.lastFocusedAt
      )
    }
    for (const entry of browserPageEntries) {
      times.set(
        encodePaletteIdentity(['page', getPaletteWorktreeIdentity(entry.worktree), entry.page.id]),
        entry.lastFocusedAt
      )
    }
    return times
  }, [workspaceTabEntries, simulatorTabEntries, browserPageEntries])
  const occurrenceIds = useMemo(() => {
    const counts = new Map<string, number>()
    return openTabItems.map((item) => {
      const base = item.id
      const ordinal = counts.get(base) ?? 0
      counts.set(base, ordinal + 1)
      return `recent-tab:${base}:${ordinal}`
    })
  }, [openTabItems])
  const terminalTabsByWorktree = useMemo(() => {
    const byWorktree = new Map<string, Map<string, TerminalTab | null>>()
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      const byId = new Map<string, TerminalTab | null>()
      for (const tab of tabs ?? []) {
        byId.set(tab.id, byId.has(tab.id) ? null : tab)
      }
      byWorktree.set(worktreeId, byId)
    }
    return byWorktree
  }, [tabsByWorktree])
  const recentTabPaneSources = useMemo<TabPaneInputSources>(
    () => ({
      entriesByTabId: buildExplicitEntriesByTabId(
        agentStatusByPaneKey,
        migrationUnsupportedByPtyId
      ),
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      terminalLayoutsByTabId
    }),
    [
      agentStatusByPaneKey,
      migrationUnsupportedByPtyId,
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      terminalLayoutsByTabId
    ]
  )
  const openTabRecentRows = useMemo<OpenTabRecentRow[]>(() => {
    const entries: OpenTabRecentRow[] = []
    for (const [index, item] of openTabItems.entries()) {
      const worktree = resolveWorktree(item.result.worktreeId, item.result.executionHostId)
      if (!worktree) {
        continue
      }
      const occurrenceId = occurrenceIds[index]!
      entries.push({
        item,
        occurrenceId,
        worktree,
        row: {
          id: item.id,
          occurrenceId,
          worktreeId: worktree.id,
          worktreeHostId: getPaletteWorktreeExecutionHostId(worktree),
          lastFocusedAt: tabFocusTimes.get(
            encodePaletteIdentity([
              item.type === 'browser-page' ? 'page' : 'tab',
              getPaletteWorktreeIdentity(worktree),
              item.type === 'browser-page' ? item.result.pageId : item.result.tabId
            ])
          ),
          unifiedTabId: item.type === 'browser-page' ? null : item.result.tabId,
          terminalTab:
            item.type === 'workspace-tab' && item.result.contentType === 'terminal'
              ? (terminalTabsByWorktree.get(worktree.id)?.get(item.result.entityId) ?? null)
              : null,
          worktreeLastActivityAt: worktree.lastActivityAt
        }
      })
    }
    return entries
  }, [occurrenceIds, openTabItems, resolveWorktree, terminalTabsByWorktree, tabFocusTimes])
  const recentTabRowByItem = useMemo(
    () => new Map(openTabRecentRows.map(({ item, row }) => [item, row])),
    [openTabRecentRows]
  )
  const recentTabRows = useMemo<RecentWorkspaceTabRow[]>(() => {
    const now = Date.now()
    const rows: RecentWorkspaceTabRow[] = []
    for (const { item, worktree, row } of openTabRecentRows) {
      if (
        shouldIncludeOpenTabInRecentSection({
          item,
          worktree,
          row,
          paneSources: recentTabPaneSources,
          unreadTerminalTabs,
          unreadAgentCompletionPanes,
          now
        })
      ) {
        rows.push(row)
      }
    }
    return rows
  }, [openTabRecentRows, recentTabPaneSources, unreadAgentCompletionPanes, unreadTerminalTabs])
  const [recentTabSnapshot, setRecentTabSnapshot] = useState(EMPTY_RECENT_TAB_SNAPSHOT)
  // Why: recent rows are already narrowed by the filter, so a filter change mid-open must
  // re-capture — a frozen order would otherwise hide rows a cleared chip brought back.
  const capturedFilterRef = useRef(filter)
  const recentOrderAttentionIncomplete = useMemo(() => {
    for (const { item, worktree, row } of openTabRecentRows) {
      if (
        item.type !== 'workspace-tab' ||
        item.result.contentType !== 'terminal' ||
        row.terminalTab ||
        worktree.isArchived
      ) {
        continue
      }
      return true
    }
    return false
  }, [openTabRecentRows])
  useLayoutEffect(() => {
    if (!visible) {
      autoSelectedItemIdRef.current = null
      setRecentTabSnapshot(EMPTY_RECENT_TAB_SNAPSHOT)
      return
    }
    if (hasQuery || query.length > 0) {
      return
    }
    const filterChanged = capturedFilterRef.current !== filter
    if (filterChanged) {
      capturedFilterRef.current = filter
    }
    if (
      !filterChanged &&
      recentTabSnapshot.order.length > 0 &&
      (recentTabSnapshot.attentionReady || recentOrderAttentionIncomplete)
    ) {
      return
    }
    const order = orderRecentWorkspaceTabs({
      rows: recentTabRows
    })
    if (order.length === 0) {
      setRecentTabSnapshot(EMPTY_RECENT_TAB_SNAPSHOT)
      return
    }
    setRecentTabSnapshot({ order, attentionReady: !recentOrderAttentionIncomplete })
    setSelectedItemId((current) =>
      current === '' || current === autoSelectedItemIdRef.current ? '' : current
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [
    filter,
    hasQuery,
    query.length,
    recentOrderAttentionIncomplete,
    recentTabSnapshot,
    recentTabPaneSources,
    recentTabRows,
    visible
  ])
  const recentTabItems = useMemo<PaletteItem[]>(() => {
    const itemByOccurrenceId = new Map(
      openTabRecentRows.map(({ occurrenceId, item }) => [occurrenceId, item])
    )
    return recentTabSnapshot.order.flatMap(
      (occurrenceId) => itemByOccurrenceId.get(occurrenceId) ?? []
    )
  }, [openTabRecentRows, recentTabSnapshot.order])

  return { recentTabPaneSources, recentTabRowByItem, recentTabItems, openTabRecentRows }
}

export type WorktreeJumpPaletteRecentTabs = ReturnType<typeof useWorktreeJumpPaletteRecentTabs>

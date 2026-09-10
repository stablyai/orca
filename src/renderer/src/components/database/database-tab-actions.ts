import { DEFAULT_DATABASE_TAB_STATE } from '../../../../shared/database-types'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  getActiveExecutionHostIdForWorktree,
  findAmbiguousWorktreeIds,
  getPaletteOwnershipWorktreeIds,
  isUnifiedTabOwnedByWorktree
} from '@/lib/unified-tab-host-ownership'

export const DATABASE_FOCUS_EVENT = 'orca:database-focus'

export function focusDatabaseTab(tabId: string): void {
  useAppStore.getState().activateTab(tabId)
  useAppStore.getState().setActiveTabType('database')
  window.dispatchEvent(new CustomEvent(DATABASE_FOCUS_EVENT, { detail: { tabId } }))
}

export function openOrFocusDatabaseTab(worktreeId: string): string | null {
  const state = useAppStore.getState()
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  const executionHostId = getActiveExecutionHostIdForWorktree(state, worktreeId)
  const worktree = state.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree) {
    return null
  }
  const ambiguous = findAmbiguousWorktreeIds(getPaletteOwnershipWorktreeIds(state))
  const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? [])
    .filter(
      (tab) =>
        tab.contentType === 'database' && isUnifiedTabOwnedByWorktree(tab, worktree, ambiguous)
    )
    .sort(
      (a, b) =>
        Number(b.groupId === groupId) - Number(a.groupId === groupId) ||
        (b.lastFocusedAt ?? b.createdAt) - (a.lastFocusedAt ?? a.createdAt)
    )
  const existing = tabs[0]
  if (existing) {
    focusDatabaseTab(existing.id)
    return existing.id
  }
  return openDatabaseTab(worktreeId, groupId)
}

export function openDatabaseTab(worktreeId: string, targetGroupId?: string): string {
  const state = useAppStore.getState()
  const tab = state.createUnifiedTab(worktreeId, 'database', {
    label: translate('auto.components.database.tab.title', 'Database Query'),
    database: {
      connection: { ...DEFAULT_DATABASE_TAB_STATE.connection },
      queryDraft: DEFAULT_DATABASE_TAB_STATE.queryDraft,
      readOnly: DEFAULT_DATABASE_TAB_STATE.readOnly
    },
    targetGroupId,
    activate: true
  })
  state.activateTab(tab.id)
  state.setActiveTabType('database')
  return tab.id
}

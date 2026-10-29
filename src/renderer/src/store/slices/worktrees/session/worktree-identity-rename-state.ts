import {
  editSessionSource,
  type OrdinarySourcePartial,
  type SessionSourceWrite
} from '../../../session-source-edits'
import type { AppState } from '../../../types'
import type {
  BrowserPage,
  BrowserWorkspace
} from '../../../../../../shared/browser-workspace-types'
import { remapBrowserPageDocLocation } from '../../../../../../shared/browser-page-doc-location'
import { splitWorktreeIdForFilesystem } from '../../../../../../shared/worktree/id'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getWorktreeIdFromVisitKey } from '@/lib/worktree-visit-recency'
import {
  remapClosedTerminalTabSnapshotCwds,
  type ClosedTerminalTabSnapshot
} from '../../recently-closed-tabs'
import { renameWorktreeLayoutKeys } from '../../tabs/worktree-layout-lifecycle'
import { renameCombinedDiffViewOwner } from '@/components/editor/combined-diff/remember-view/combined-diff-view-cache'

// Inventory non-layout worktree-keyed maps; layout migrates separately, while surviving tab/file IDs keep their keys.
const WORKTREE_ID_KEYED_MAP_KEYS = [
  'worktreeLineageById',
  'deleteStateByWorktreeId',
  'baseStatusByWorktreeId',
  'remoteBranchConflictByWorktreeId',
  'fileSearchStateByWorktree',
  'recentlyClosedBrowserTabsByWorktree',
  'pendingReconnectTabByWorktree',
  'rightSidebarTabByWorktree',
  'rightSidebarExplorerViewByWorktree',
  'gitStatusByWorktree',
  'gitStatusHeadByWorktree',
  'gitStatusReadErrorByWorktree',
  'gitBranchLineTotalByWorktree',
  'gitIgnoredPathsByWorktree',
  'gitConflictOperationByWorktree',
  'trackedConflictPathsByWorktree',
  'gitBranchChangesByWorktree',
  'gitBranchCompareSummaryByWorktree',
  'gitBranchCompareRequestKeyByWorktree',
  'gitBranchCompareRequestStatusHeadByWorktree',
  'explorerDisplayRootByWorktree',
  'showDotfilesByWorktree',
  'expandedDirs',
  'recentlyClosedTabKindsByWorktree'
] as const satisfies readonly (keyof AppState)[]

/** Rekey worktree maps and valued pointers, preserving tab/file IDs; main counterpart is Store.migrateWorktreeIdentity in persistence.ts. */
export function buildWorktreeRenameState(
  s: AppState,
  oldWorktreeId: string,
  newWorktreeId: string
): SessionSourceWrite<AppState> {
  const edit = editSessionSource(s)
  if (oldWorktreeId === newWorktreeId) {
    return edit.finish()
  }
  renameCombinedDiffViewOwner(oldWorktreeId, newWorktreeId)
  const renamed: Record<string, unknown> = {}
  const renameKey = <T>(
    key: keyof AppState,
    mapValue: (value: T) => T = (value) => value
  ): void => {
    const map = s[key as keyof AppState] as Record<string, unknown> | undefined
    if (!map || !(oldWorktreeId in map)) {
      return
    }
    const next = { ...map }
    next[newWorktreeId] = mapValue(next[oldWorktreeId] as T)
    delete next[oldWorktreeId]
    renamed[key] = next
  }
  const withNewWorktreeId = <T extends { worktreeId: string }>(value: T): T =>
    value.worktreeId === oldWorktreeId ? { ...value, worktreeId: newWorktreeId } : value
  const oldWorktreePath = splitWorktreeIdForFilesystem(oldWorktreeId)?.worktreePath
  const newWorktreePath = splitWorktreeIdForFilesystem(newWorktreeId)?.worktreePath
  const withNewBrowserWorktreeId = <T extends BrowserPage | BrowserWorkspace>(value: T): T => {
    const renamedValue = withNewWorktreeId(value)
    return value.docLocation?.worktreeId === oldWorktreeId
      ? {
          ...renamedValue,
          docLocation: remapBrowserPageDocLocation(
            value.docLocation,
            oldWorktreeId,
            newWorktreeId,
            oldWorktreePath,
            newWorktreePath
          )
        }
      : renamedValue
  }
  const renameValueByKey: Partial<Record<(typeof WORKTREE_ID_KEYED_MAP_KEYS)[number], unknown>> = {
    recentlyClosedBrowserTabsByWorktree: (
      snapshots: { workspace: BrowserWorkspace; pages: BrowserPage[] }[]
    ) =>
      snapshots.map((snapshot) => ({
        ...snapshot,
        workspace: withNewBrowserWorktreeId(snapshot.workspace),
        pages: snapshot.pages.map(withNewBrowserWorktreeId)
      })),
    fileSearchStateByWorktree: (searchState: AppState['fileSearchStateByWorktree'][string]) => ({
      ...searchState,
      resultOwner: searchState.resultOwner ? withNewWorktreeId(searchState.resultOwner) : null
    })
  }
  for (const key of WORKTREE_ID_KEYED_MAP_KEYS) {
    renameKey(key, renameValueByKey[key] as ((value: unknown) => unknown) | undefined)
  }
  // Recency keys may carry a host prefix. Preserve that prefix while moving
  // the path-derived id so a rename cannot merge host twins.
  for (const [key, value] of Object.entries(s.lastVisitedAtByWorktreeId)) {
    const rawId = getWorktreeIdFromVisitKey(key)
    if (rawId !== oldWorktreeId) {
      continue
    }
    const nextKey =
      rawId === key ? newWorktreeId : `${key.slice(0, key.length - rawId.length)}${newWorktreeId}`
    edit.set('lastVisitedAtByWorktreeId', nextKey, value)
    edit.remove('lastVisitedAtByWorktreeId', key)
  }
  if (edit.has('defaultTerminalTabsAppliedByWorktreeId', oldWorktreeId)) {
    edit.set(
      'defaultTerminalTabsAppliedByWorktreeId',
      newWorktreeId,
      s.defaultTerminalTabsAppliedByWorktreeId[oldWorktreeId]
    )
    edit.remove('defaultTerminalTabsAppliedByWorktreeId', oldWorktreeId)
  }
  // Re-key on rename so a renamed worktree keeps its editor-undo + push/pull state.
  renameKey('recentlyClosedEditorTabsByWorktree', (files: { worktreeId: string }[]) =>
    files.map(withNewWorktreeId)
  )
  // Remap absolute startupCwd in reopen snapshots or Cmd+Shift+T spawns into the vanished old directory.
  renameKey('recentlyClosedTerminalTabsByWorktree', (snapshots: ClosedTerminalTabSnapshot[]) =>
    oldWorktreePath && newWorktreePath
      ? remapClosedTerminalTabSnapshotCwds(snapshots, oldWorktreePath, newWorktreePath)
      : snapshots
  )
  renameKey('remoteStatusesByWorktree')

  for (const [workspaceId, pages] of Object.entries(s.browserPagesByWorkspace ?? {})) {
    const next = pages.map(withNewBrowserWorktreeId)
    if (next.some((page, index) => page !== pages[index])) {
      edit.set('browserPagesByWorkspace', workspaceId, next)
    }
  }
  const currentRecentlyClosedBrowserPagesByWorkspace = s.recentlyClosedBrowserPagesByWorkspace ?? {}
  const recentlyClosedBrowserPagesByWorkspace = Object.values(
    currentRecentlyClosedBrowserPagesByWorkspace
  ).some((pages) =>
    pages.some(
      (page) => page.worktreeId === oldWorktreeId || page.docLocation?.worktreeId === oldWorktreeId
    )
  )
    ? Object.fromEntries(
        Object.entries(currentRecentlyClosedBrowserPagesByWorkspace).map(([workspaceId, pages]) => [
          workspaceId,
          pages.map(withNewBrowserWorktreeId)
        ])
      )
    : s.recentlyClosedBrowserPagesByWorkspace
  let everActivated = s.everActivatedWorktreeIds
  if (everActivated.has(oldWorktreeId)) {
    everActivated = new Set(everActivated)
    everActivated.delete(oldWorktreeId)
    everActivated.add(newWorktreeId)
  }
  const pendingReconnectWorktreeIds = s.pendingReconnectWorktreeIds?.includes(oldWorktreeId)
    ? s.pendingReconnectWorktreeIds.map((id) => (id === oldWorktreeId ? newWorktreeId : id))
    : s.pendingReconnectWorktreeIds
  // Repoint worktreeId values in non-worktree-keyed close records: stale terminal tombstones fail matching; stale browser intents read selector_not_found as final and disappear, resurrecting closed surfaces.
  const repointRows = <T extends { worktreeId: string }>(
    rows: readonly T[]
  ): { rows: T[]; changed: boolean } => {
    let changed = false
    const next = rows.map((row) => {
      if (row.worktreeId !== oldWorktreeId) {
        return row
      }
      changed = true
      return { ...row, worktreeId: newWorktreeId }
    })
    return { rows: next, changed }
  }
  const currentClosedTombstones = s.closedTerminalTabTombstonesByTabId ?? {}
  const closedTombstoneEntries = repointRows(
    Object.entries(currentClosedTombstones).map(([tabId, tombstone]) => ({ ...tombstone, tabId }))
  )
  const closedTerminalTabTombstonesByTabId = closedTombstoneEntries.changed
    ? Object.fromEntries(
        closedTombstoneEntries.rows.map(({ tabId, ...tombstone }) => [tabId, tombstone])
      )
    : s.closedTerminalTabTombstonesByTabId
  for (const [environmentId, intents] of Object.entries(
    s.clientHostedBrowserCloseIntentsByEnvironment ?? {}
  )) {
    const repointed = repointRows(intents)
    if (repointed.changed) {
      edit.set('clientHostedBrowserCloseIntentsByEnvironment', environmentId, repointed.rows)
    }
  }
  for (const [environmentId, intents] of Object.entries(
    s.pairedTerminalTabCloseIntentsByEnvironment ?? {}
  )) {
    const repointed = repointRows(intents)
    if (repointed.changed) {
      edit.set('pairedTerminalTabCloseIntentsByEnvironment', environmentId, repointed.rows)
    }
  }
  for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey ?? {})) {
    if (record.worktreeId === oldWorktreeId) {
      edit.set('sleepingAgentSessionsByPaneKey', paneKey, { ...record, worktreeId: newWorktreeId })
    }
  }
  const layout = renameWorktreeLayoutKeys(
    edit,
    oldWorktreeId,
    newWorktreeId,
    withNewBrowserWorktreeId
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the explicit inventory and renameKey calls above contain only non-source fields.
  const ordinary = renamed as OrdinarySourcePartial<AppState>

  return edit.finish({
    ...layout,
    ...ordinary,
    ...(recentlyClosedBrowserPagesByWorkspace !== s.recentlyClosedBrowserPagesByWorkspace
      ? { recentlyClosedBrowserPagesByWorkspace }
      : {}),
    ...(everActivated !== s.everActivatedWorktreeIds
      ? { everActivatedWorktreeIds: everActivated }
      : {}),
    ...(pendingReconnectWorktreeIds !== s.pendingReconnectWorktreeIds
      ? { pendingReconnectWorktreeIds }
      : {}),
    ...(closedTerminalTabTombstonesByTabId !== s.closedTerminalTabTombstonesByTabId
      ? { closedTerminalTabTombstonesByTabId }
      : {}),
    ...(s.activeWorktreeId === oldWorktreeId ? { activeWorktreeId: newWorktreeId } : {}),
    // The active workspace key derives from the worktree id, so keep it in sync when the active worktree is renamed.
    ...(s.activeWorkspaceKey === worktreeWorkspaceKey(oldWorktreeId)
      ? { activeWorkspaceKey: worktreeWorkspaceKey(newWorktreeId) }
      : {}),
    ...(s.renamingWorktreeId?.worktreeId === oldWorktreeId
      ? { renamingWorktreeId: { ...s.renamingWorktreeId, worktreeId: newWorktreeId } }
      : {})
  })
}

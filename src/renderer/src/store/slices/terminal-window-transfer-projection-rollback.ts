import type { AppState } from '../types'

export type TransferRollbackPatch = Record<string, unknown>

const TAB_KEYED_FIELDS = [
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'lastKnownRelayPtyIdByTabId',
  'deferredSshSessionIdsByTabId',
  'pendingReconnectPtyIdByTabId',
  'directSshPaneRetryByTabId',
  'directSshLivePtyBindingByTabId',
  'directSshPaneRetryHistoryByTabId',
  'runtimePaneTitlesByTabId',
  'expandedPaneByTabId',
  'canExpandPaneByTabId',
  'pendingStartupByTabId',
  'pendingInitialCwdByTabId',
  'pendingSetupSplitByTabId',
  'pendingIssueCommandSplitByTabId',
  'automaticAgentResumeClaimsByTabId',
  'nativeChatLaunchPromptByTabId',
  'nativeChatLaunchDraftByTabId',
  'unreadTerminalTabs',
  'recentlyClosedAgentStatusTabIds'
] as const satisfies readonly (keyof AppState)[]

const PANE_KEYED_FIELDS = [
  'agentStatusByPaneKey',
  'runtimeAgentOrchestrationByPaneKey',
  'retainedAgentsByPaneKey',
  'sleepingAgentSessionsByPaneKey',
  'agentLaunchConfigByPaneKey',
  'acknowledgedAgentsByPaneKey',
  'paneForegroundAgentByPaneKey',
  'unreadTerminalPanes',
  'unreadAgentCompletionPanes',
  'lastTerminalInputAtByPaneKey',
  'cacheTimerByKey',
  'retentionSuppressedPaneKeys',
  'recentlyRetiredAgentStatusPaneKeys'
] as const satisfies readonly (keyof AppState)[]

const WORKTREE_SELECTOR_FIELDS = [
  'activeGroupIdByWorktree',
  'activeTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeFileIdByWorktree',
  'activeBrowserTabIdByWorktree'
] as const satisfies readonly (keyof AppState)[]

const SCALAR_SELECTOR_FIELDS = [
  'activeRepoId',
  'activeWorktreeId',
  'activeWorkspaceKey',
  'activeWorkspaceExecutionHostId',
  'activeTabId',
  'activeTabType',
  'activeFileId',
  'activeBrowserTabId',
  'agentStatusEpoch',
  'sortEpoch'
] as const satisfies readonly (keyof AppState)[]

export function recordValue(state: AppState, field: keyof AppState): TransferRollbackPatch {
  const value = (state as unknown as TransferRollbackPatch)[field]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as TransferRollbackPatch)
    : {}
}

function sameEntry(
  left: TransferRollbackPatch,
  right: TransferRollbackPatch,
  key: string
): boolean {
  return Object.hasOwn(left, key) === Object.hasOwn(right, key) && Object.is(left[key], right[key])
}

export function restoreTransferRecordKeys(
  patch: TransferRollbackPatch,
  before: AppState,
  after: AppState,
  current: AppState,
  field: keyof AppState,
  keys: Iterable<string>
): void {
  const beforeRecord = recordValue(before, field)
  const afterRecord = recordValue(after, field)
  const currentRecord = recordValue(current, field)
  let next = currentRecord
  for (const key of keys) {
    if (sameEntry(beforeRecord, afterRecord, key) || !sameEntry(currentRecord, afterRecord, key)) {
      continue
    }
    if (next === currentRecord) {
      next = { ...currentRecord }
    }
    if (Object.hasOwn(beforeRecord, key)) {
      next[key] = beforeRecord[key]
    } else {
      delete next[key]
    }
  }
  if (next !== currentRecord) {
    patch[field] = next
  }
}

export function restoreTransferLocalProjections(
  patch: TransferRollbackPatch,
  before: AppState,
  after: AppState,
  current: AppState,
  tabId: string
): void {
  for (const field of TAB_KEYED_FIELDS) {
    restoreTransferRecordKeys(patch, before, after, current, field, [tabId])
  }
  const panePrefix = `${tabId}:`
  for (const field of PANE_KEYED_FIELDS) {
    const keys = new Set(
      [
        ...Object.keys(recordValue(before, field)),
        ...Object.keys(recordValue(after, field))
      ].filter((key) => key.startsWith(panePrefix))
    )
    restoreTransferRecordKeys(patch, before, after, current, field, keys)
  }
  const migrationKeys = new Set(
    [
      ...Object.keys(before.migrationUnsupportedByPtyId),
      ...Object.keys(after.migrationUnsupportedByPtyId)
    ].filter(
      (key) =>
        before.migrationUnsupportedByPtyId[key]?.paneKey?.startsWith(panePrefix) ||
        after.migrationUnsupportedByPtyId[key]?.paneKey?.startsWith(panePrefix)
    )
  )
  restoreTransferRecordKeys(
    patch,
    before,
    after,
    current,
    'migrationUnsupportedByPtyId',
    migrationKeys
  )
}

export function restoreTransferSelectors(
  patch: TransferRollbackPatch,
  before: AppState,
  after: AppState,
  current: AppState,
  worktreeIds: ReadonlySet<string>
): void {
  for (const field of WORKTREE_SELECTOR_FIELDS) {
    restoreTransferRecordKeys(patch, before, after, current, field, worktreeIds)
  }
  for (const field of SCALAR_SELECTOR_FIELDS) {
    if (!Object.is(before[field], after[field]) && Object.is(current[field], after[field])) {
      patch[field] = before[field]
    }
  }
}

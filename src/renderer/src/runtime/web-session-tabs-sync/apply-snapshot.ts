import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type {
  WebSessionTabsBatchContext,
  WebSessionTabsSnapshotApplyOptions,
  WebSessionTabsSyncState
} from './state'
import { suppressE2eWebRuntimeBrowserSnapshot } from '../web-runtime-browser-creation-e2e-fault'
import { prepareWebSessionTabsSnapshotBase } from './apply-preparation-base'
import { prepareWebSessionTabsSnapshotBrowser } from './apply-preparation-browser'
import { prepareWebSessionTabsSnapshotUnified } from './apply-preparation-unified'
import { prepareWebSessionTabsSnapshotGroups } from './apply-preparation-groups'
import { applyTerminalRecordUpdates } from './apply-terminal-records'
import { applyBrowserRecordUpdates } from './apply-browser-records'
import { applyWorktreeRecordUpdates } from './apply-worktree-records'
import { applyActiveStateUpdates } from './apply-active-state'
import { buildWebSessionTabsFinalPatch } from './apply-final-patch'
import {
  resolveTerminalSnapshotLocalIds,
  indexTerminalSnapshotHosts
} from './terminal-snapshot-host-ownership'

/** Reconcile one host frame through the staged terminal/browser/layout pipeline. */
export function applyWebSessionTabsSnapshotWithContext(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now(),
  batchContext?: WebSessionTabsBatchContext,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (
    suppressE2eWebRuntimeBrowserSnapshot(rawSnapshot) ||
    rawSnapshot.worktree === FLOATING_TERMINAL_WORKTREE_ID
  ) {
    return state
  }
  const worktreeId = rawSnapshot.worktree
  const terminalHostById = indexTerminalSnapshotHosts(state, worktreeId)
  const terminalLocalIdByHostId = resolveTerminalSnapshotLocalIds(
    state,
    rawSnapshot,
    environmentId,
    terminalHostById
  )
  const base = prepareWebSessionTabsSnapshotBase(
    state,
    rawSnapshot,
    environmentId,
    worktreeId,
    now,
    batchContext,
    options,
    terminalHostById,
    terminalLocalIdByHostId
  )
  const browser = prepareWebSessionTabsSnapshotBrowser(base)
  const unified = prepareWebSessionTabsSnapshotUnified(browser)
  const groups = prepareWebSessionTabsSnapshotGroups(unified)
  const terminalRecords = applyTerminalRecordUpdates(groups)
  const browserRecords = applyBrowserRecordUpdates(terminalRecords)
  const worktreeRecords = applyWorktreeRecordUpdates(browserRecords)
  const activeState = applyActiveStateUpdates(worktreeRecords)
  return buildWebSessionTabsFinalPatch(activeState)
}

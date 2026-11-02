import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'
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
import { isFrameDrawnServerWorkspace } from './frame-drawn-server-workspaces'
import { buildFrameDrawnWorkspaceStatusPatch } from './frame-drawn-workspace-status-patch'
import { indexMirroredTerminalSurfaces } from './mirrored-terminal-handle-index'

export function applyWebSessionTabsSnapshotWithContext(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now(),
  batchContext?: WebSessionTabsBatchContext,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  // Why: the floating panel is this machine's own, so only its local chat inventory may write it.
  const isLocalChatInventory =
    environmentId === LOCAL_STRUCTURED_SESSION_OWNER && options?.contentScope === 'agent-session'
  if (
    suppressE2eWebRuntimeBrowserSnapshot(rawSnapshot) ||
    (rawSnapshot.worktree === FLOATING_TERMINAL_WORKTREE_ID && !isLocalChatInventory)
  ) {
    return state
  }
  const worktreeId = rawSnapshot.worktree
  // Switch point: ORCA_LAYOUT_OWNER_IS_MAIN && — every mirror write (single, batch, operations) passes here.
  const previousSnapshotTabIds =
    ORCA_LAYOUT_OWNER_IS_MAIN && options?.contentScope !== 'agent-session'
      ? indexMirroredTerminalSurfaces(environmentId, rawSnapshot)
      : null
  const frameDrawnPreviousTabIds =
    previousSnapshotTabIds && isFrameDrawnServerWorkspace(environmentId, worktreeId)
      ? previousSnapshotTabIds
      : null
  if (frameDrawnPreviousTabIds) {
    // Server frames own tabs/IDs/focus and writes use server IDs; skip mirror intent ledgers for these workspaces.
    return buildFrameDrawnWorkspaceStatusPatch(
      state,
      rawSnapshot,
      environmentId,
      worktreeId,
      frameDrawnPreviousTabIds,
      now,
      batchContext
    )
  }
  // Interim (ledger L240): from here on only for a server without `layout.intents.v1`, until the
  // Phase 2 server cutoff retires the mirror's tab ids, close and focus intents.
  const base = prepareWebSessionTabsSnapshotBase(
    state,
    rawSnapshot,
    environmentId,
    worktreeId,
    now,
    batchContext,
    options
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

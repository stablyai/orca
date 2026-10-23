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

/** Reconcile one host frame through the staged terminal/browser/layout pipeline. */
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
  // A frame-drawn workspace still runs these stages for their intent and id-mapping ledgers; unbatched
  // so their discarded record copies never reach the batch's shared state.
  const base = prepareWebSessionTabsSnapshotBase(
    state,
    rawSnapshot,
    environmentId,
    worktreeId,
    now,
    frameDrawnPreviousTabIds ? undefined : batchContext,
    options
  )
  const browser = prepareWebSessionTabsSnapshotBrowser(base)
  const unified = prepareWebSessionTabsSnapshotUnified(browser)
  if (frameDrawnPreviousTabIds) {
    return buildFrameDrawnWorkspaceStatusPatch(
      state,
      base.snapshot,
      environmentId,
      worktreeId,
      frameDrawnPreviousTabIds,
      now,
      batchContext
    )
  }
  const groups = prepareWebSessionTabsSnapshotGroups(unified)
  const terminalRecords = applyTerminalRecordUpdates(groups)
  const browserRecords = applyBrowserRecordUpdates(terminalRecords)
  const worktreeRecords = applyWorktreeRecordUpdates(browserRecords)
  const activeState = applyActiveStateUpdates(worktreeRecords)
  return buildWebSessionTabsFinalPatch(activeState)
}

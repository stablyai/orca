import { vi, type Mock } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { AppState } from '@/store'

/** Shared with the frame-ordering suites through their `vi.mock` factories, so
 *  this module must stay free of runtime imports that would form a cycle. */
export const frameOrderingMocks: Record<
  | 'createTerminal'
  | 'queueAcceptedSnapshot'
  | 'recoverSnapshot'
  | 'runtimeSessionMirrorEnvironmentKey',
  Mock
> = {
  createTerminal: vi.fn(),
  // Inert by default: nothing here subscribes to web session terminal handles.
  queueAcceptedSnapshot: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}

export const ENV = 'env-abfee683'
export const REPO_ID = 'repo-1'
export const WT = `${REPO_ID}::/workspace/feature`
export const BG_WT = `${REPO_ID}::/workspace/background`
export const REVISION = 101
export const MIRROR_KEY = `${ENV}\u0001runtime-a\u00011\u0001${REVISION}`

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const HOST_PARENT_TAB_ID = 'host-tab-1'
export const HOST_SURFACE_ID = `${HOST_PARENT_TAB_ID}::${LEAF_ID}`
// The mirror names its local tab after the host PARENT tab, not the surface id.
export const MIRROR_TAB_ID = toWebTerminalSurfaceTabId(HOST_PARENT_TAB_ID)
export const HOST_PTY_ID = `remote:${ENV}@@terminal-1`

export const BG_MIRROR_TAB_ID = toWebTerminalSurfaceTabId('host-tab-2')

export const FLOATING_HOST_PARENT_TAB_ID = 'host-tab-floating'
export const FLOATING_HOST_SURFACE_ID = `${FLOATING_HOST_PARENT_TAB_ID}::${LEAF_ID}`

// A host tab that is NOT the parked mirror: publishing it retracts MIRROR_TAB_ID,
// which is the host answering "that pane is gone" rather than staying silent.
export const OTHER_HOST_PARENT_TAB_ID = 'host-tab-9'
export const OTHER_HOST_SURFACE_ID = `${OTHER_HOST_PARENT_TAB_ID}::${LEAF_ID}`

export function makeWorktree(
  id: string,
  path: string
): AppState['worktreesByRepo'][string][number] {
  return {
    id,
    repoId: REPO_ID,
    path,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: path,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    // The workspace is owned by the paired runtime — the incident shape.
    hostId: `runtime:${encodeURIComponent(ENV)}`
  } as never
}

/** A host frame publishing one ready terminal surface backed by a live PTY. */
export function makeHostSnapshot(
  worktree: string,
  hostSurfaceId: string,
  parentTabId: string
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: hostSurfaceId,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: hostSurfaceId,
        title: 'Codex',
        parentTabId,
        leafId: LEAF_ID,
        isActive: true,
        launchAgent: 'codex',
        status: 'ready',
        terminal: 'terminal-1'
      }
    ]
  } as never
}

/** The host reports zero terminals: the same frame retracts the mirror tab and
 *  asks the client to respawn one. */
export function makeEmptyHostSnapshot(worktree: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  } as never
}

/** A published tab whose PTY handle has not landed yet — the undecidable
 *  mirror shape that makes a resume sweep park instead of deciding. */
export function makePtylessHostSnapshot(
  worktree: string,
  hostSurfaceId: string,
  parentTabId: string,
  snapshotVersion = 1
): RuntimeMobileSessionTabsResult {
  const snapshot = makeHostSnapshot(worktree, hostSurfaceId, parentTabId) as never as {
    snapshotVersion: number
    tabs: Record<string, unknown>[]
  }
  snapshot.snapshotVersion = snapshotVersion
  Object.assign(snapshot.tabs[0]!, { status: 'pending-handle', terminal: null })
  return snapshot as never
}

export function mirrorTabRow(tabId: string, worktreeId: string): unknown {
  return { id: tabId, title: 'Codex', ptyId: null, worktreeId }
}

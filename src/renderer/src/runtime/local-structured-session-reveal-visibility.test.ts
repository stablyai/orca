// @vitest-environment happy-dom

/**
 * Reopening a closed chat has to survive the frames the reopen itself provokes.
 *
 * The renderer publishes under one epoch string for its whole lifetime, so a frame recorded under
 * a different lineage retires that epoch permanently — and the click that reopens a chat asks the
 * host for an inventory first, which answers `none`/v0 for a worktree it holds no entry for. That
 * answer used to be recorded, retiring the renderer's own epoch and dropping the republished tab
 * that arrived moments later. The chat only reappeared after a reload minted a new epoch.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner'
import {
  applyLocalStructuredSessionTabSnapshots,
  resetLocalStructuredSessionVersionForTests
} from './local-structured-session-tabs-sync'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync'

const WORKTREE = 'repo-1::/tmp/wt-reveal'
const HOST_TAB_ID = 'agent-session:codex-reveal-1'
// The projection renames a host tab id into the renderer's own namespace.
const SESSION_TAB = 'structured-agent-session-codex-reveal-1'
// One string for the renderer's whole lifetime, which is exactly why retiring it is unrecoverable.
const RENDERER_EPOCH = 'renderer:11111111-2222-3333-4444-555555555555'

type SyncState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

function baseState(): SyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WORKTREE,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    // Required: without a catalog entry the trailing cleanup deletes the cursor and hides the bug.
    worktreesByRepo: { 'repo-1': [{ id: WORKTREE, path: '/tmp/wt-reveal' }] }
  } as unknown as SyncState
}

function chatFrame(epoch: string, version: number): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: `headless-terminals:${WORKTREE}`,
    activeTabId: HOST_TAB_ID,
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: HOST_TAB_ID,
        title: 'Codex Chat',
        sessionId: 'codex-reveal-1',
        agent: 'codex',
        isActive: true
      }
    ]
  } as unknown as RuntimeMobileSessionTabsResult
}

function emptyFrame(epoch: string, version: number): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  } as unknown as RuntimeMobileSessionTabsResult
}

function apply(state: SyncState, snapshot: RuntimeMobileSessionTabsResult): SyncState {
  return applyLocalStructuredSessionTabSnapshots(state, [snapshot])
}

function chatTabIds(state: SyncState): string[] {
  return (state.unifiedTabsByWorktree[WORKTREE] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.id)
}

describe('a revealed chat survives the frames the reveal provokes', () => {
  it('reopens after the click asks an unpublished worktree for its inventory', () => {
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    expect(chatTabIds(state)).toHaveLength(1)

    state = apply(state, emptyFrame(RENDERER_EPOCH, 121)) // the user closes the chat
    expect(chatTabIds(state)).toEqual([])

    // The Resume click's own `session.tabs.list`: the host holds no entry, so it answers the
    // sentinel. Recording it retired the renderer's epoch and poisoned the reveal that follows.
    state = apply(state, emptyFrame(UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH, 0))

    state = apply(state, chatFrame(RENDERER_EPOCH, 122)) // reveal republishes

    expect(chatTabIds(state)).toEqual([SESSION_TAB])
  })

  it('reopens after the host pruned and rebuilt its entry for the worktree', () => {
    // A rebuilt host entry restarts its own counter, so the republished frame can carry a version
    // below the cursor the renderer recorded. Fencing on that alone discards a live publication.
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    state = apply(state, emptyFrame(RENDERER_EPOCH, 121))

    state = apply(state, { ...emptyFrame('removed:abc', 0), removed: true } as never)
    state = apply(state, chatFrame(RENDERER_EPOCH, 9))

    expect(chatTabIds(state)).toEqual([SESSION_TAB])
  })

  it('still prunes the mirrored rows when the host retracts the worktree', () => {
    // The retraction must not merely stop fencing later frames — it has to take the rows with it,
    // or a worktree the host no longer publishes keeps a chat on screen that nothing backs.
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    expect(chatTabIds(state)).toEqual([SESSION_TAB])

    state = apply(state, { ...chatFrame('removed:abc', 0), tabs: [], removed: true } as never)

    expect(chatTabIds(state)).toEqual([])
  })

  it('still ignores a genuinely superseded republication', () => {
    // The fences exist for a reason: without an intervening non-publication frame, an older
    // version under the same lineage must still lose.
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    state = apply(state, emptyFrame(RENDERER_EPOCH, 121))

    state = apply(state, chatFrame(RENDERER_EPOCH, 9))

    expect(chatTabIds(state)).toEqual([])
  })
})

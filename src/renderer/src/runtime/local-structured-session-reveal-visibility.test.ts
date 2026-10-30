// @vitest-environment happy-dom

// Renderer uses one lifetime epoch. Recording a forced none/v0 or retraction retired it and dropped later reopened chats until reload. Reopen must survive the inventory and retraction frames it provokes.

import { afterEach, describe, expect, it } from 'vitest'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner-state'
import { applyLocalStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

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

    state = apply(state, emptyFrame(RENDERER_EPOCH, 121))
    expect(chatTabIds(state)).toEqual([])

    // Resume inventory answers none for absent worktree; recording that sentinel poisons the renderer epoch’s reveal.
    state = apply(state, emptyFrame(UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH, 0))

    state = apply(state, chatFrame(RENDERER_EPOCH, 122))

    expect(chatTabIds(state)).toEqual([SESSION_TAB])
  })

  it('reopens after the host pruned and rebuilt its entry for the worktree', () => {
    // Last close prunes host entry and retracts it; recording retraction retired the lifetime renderer epoch. Rebuild starts a fresh epoch at v1.
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    state = apply(state, emptyFrame(RENDERER_EPOCH, 121))

    state = apply(state, { ...emptyFrame('removed:abc', 0), removed: true } as never)
    state = apply(state, chatFrame('structured:mf3k1', 1))

    expect(chatTabIds(state)).toEqual([SESSION_TAB])
  })

  it('does not let a frame from before the retraction strand a row', () => {
    // Retain cursor so pre-close list replies cannot resurrect unpublished chats.
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    state = apply(state, emptyFrame(RENDERER_EPOCH, 121))
    state = apply(state, { ...emptyFrame('removed:abc', 0), removed: true } as never)

    state = apply(state, chatFrame(RENDERER_EPOCH, 119))

    expect(chatTabIds(state)).toEqual([])
  })

  it('does not retire the renderer\u2019s own epoch when a reveal republishes under a new one', () => {
    // Consumer also publishes: retaining current epoch would retire its lifetime renderer epoch on fresh reveal and drop the next chat one cycle later.
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    state = apply(state, emptyFrame(RENDERER_EPOCH, 121))
    state = apply(state, { ...emptyFrame('removed:abc', 0), removed: true } as never)
    state = apply(state, chatFrame('structured:mf3k1', 1))

    state = apply(state, emptyFrame('structured:mf3k1', 2))
    state = apply(state, chatFrame(RENDERER_EPOCH, 130))

    expect(chatTabIds(state)).toEqual([SESSION_TAB])
  })

  it('still fences a delayed frame from an epoch that was already superseded', () => {
    // Retain retired tombstones; version cursors only fence within lineage and cannot block dead-epoch stragglers.
    let state = apply(baseState(), chatFrame('structured:old', 5))
    state = apply(state, chatFrame(RENDERER_EPOCH, 120))
    state = apply(state, emptyFrame(RENDERER_EPOCH, 121))
    state = apply(state, { ...emptyFrame('removed:abc', 0), removed: true } as never)

    state = apply(state, chatFrame('structured:old', 6))

    expect(chatTabIds(state)).toEqual([])
  })

  it('still prunes the mirrored rows when the host retracts the worktree', () => {
    // Retraction must remove rows too, not merely stop fencing, or unpublished chats remain visible.
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    expect(chatTabIds(state)).toEqual([SESSION_TAB])

    state = apply(state, { ...chatFrame('removed:abc', 0), tabs: [], removed: true } as never)

    expect(chatTabIds(state)).toEqual([])
  })

  it('still ignores a genuinely superseded republication', () => {
    // Without non-publication in between, older same-lineage frames must still lose.
    let state = apply(baseState(), chatFrame(RENDERER_EPOCH, 120))
    state = apply(state, emptyFrame(RENDERER_EPOCH, 121))

    state = apply(state, chatFrame(RENDERER_EPOCH, 9))

    expect(chatTabIds(state)).toEqual([])
  })
})

// @vitest-environment happy-dom
//
// Scratch repro: a host-published structured chat tab is dropped by the LIVE renderer
// when the host's stored snapshotVersion for the worktree regresses under an unchanged
// publication lineage (the `renderer:<uuid>` epoch), which is exactly what happens after
// the host prunes and recreates its per-worktree entry.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  applyLocalStructuredSessionTabSnapshots,
  resetLocalStructuredSessionVersionForTests
} from './local-structured-session-tabs-sync'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'

const W = 'repo-1::/tmp/wt1'
// Stable for the whole renderer lifetime: src/renderer/src/runtime/sync-runtime-graph/graph-state.ts:36
const RENDERER_EPOCH = 'renderer:11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebSessionFocusIntentForTests()
})
afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionFocusIntentForTests()
})

function emptyState(): WebSessionTabsSyncState {
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
    activeWorktreeId: W,
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
    sortEpoch: 0
  }
}

/** What `publishStructuredAgentSessionTab` emits for a chat tab on this worktree. */
function chatSnapshot(
  publicationEpoch: string,
  snapshotVersion: number
): RuntimeMobileSessionTabsResult {
  return {
    worktree: W,
    publicationEpoch,
    snapshotVersion,
    // Observed in QA: the host had no `tabGroups`, so the publish defaulted to this group id.
    activeGroupId: `headless-terminals:${W}`,
    activeTabId: 'agent-session:codex-1',
    activeTabType: 'agent-session',
    tabGroups: [
      {
        id: `headless-terminals:${W}`,
        activeTabId: 'agent-session:codex-1',
        tabOrder: ['agent-session:codex-1']
      }
    ],
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:codex-1',
        title: 'Codex Chat',
        sessionId: 'codex-1',
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

function emptySnapshot(
  publicationEpoch: string,
  snapshotVersion: number
): RuntimeMobileSessionTabsResult {
  return {
    worktree: W,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabGroups: [],
    tabs: []
  }
}

function apply(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return applyLocalStructuredSessionTabSnapshots(state, [snapshot])
}

function chatTabIds(state: WebSessionTabsSyncState): string[] {
  return (state.unifiedTabsByWorktree[W] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.entityId)
}

describe('structured chat absorption after a host stored-version regression', () => {
  it('DROPS the republished chat tab when the host version regressed under the same epoch', () => {
    let state = emptyState()

    // 1. Chat is live. The host's per-worktree counter has been bumped many times by
    //    main-local touches (agent-status heartbeats, publishes) on top of the renderer's.
    state = apply(state, chatSnapshot(RENDERER_EPOCH, 120))
    expect(chatTabIds(state)).toEqual(['codex-1'])

    // 2. User closes the chat tab; the worktree goes empty.
    state = apply(state, emptySnapshot(RENDERER_EPOCH, 121))
    expect(chatTabIds(state)).toEqual([])

    // 3. The host pruned its entry for the empty worktree and recreated it from the
    //    renderer's own global publication counter (orca-runtime-sync-mobile-session-tabs.ts:163-165
    //    stores `nextSnapshot.snapshotVersion` verbatim when `existing` is undefined).
    //    `agentSession.reveal` then republishes on top of that, still under `renderer:<uuid>`.
    state = apply(state, chatSnapshot(RENDERER_EPOCH, 9))

    // THE BUG: the tab never reaches the store, so activateStructuredAgentSessionById fails.
    expect(chatTabIds(state)).toEqual([])
  })

  it('CONTROL: the identical republish lands when its version clears the stale cursor', () => {
    let state = emptyState()
    state = apply(state, chatSnapshot(RENDERER_EPOCH, 120))
    state = apply(state, emptySnapshot(RENDERER_EPOCH, 121))

    state = apply(state, chatSnapshot(RENDERER_EPOCH, 122))

    // Same frame, same state, same host filter, same epoch history -> only the version differs.
    expect(chatTabIds(state)).toEqual(['codex-1'])
  })

  it('CONTROL: a renderer reload (cleared module cursors) absorbs the low-version republish', () => {
    let state = emptyState()
    state = apply(state, chatSnapshot(RENDERER_EPOCH, 120))
    state = apply(state, emptySnapshot(RENDERER_EPOCH, 121))

    resetLocalStructuredSessionVersionForTests() // what a renderer reload does

    state = apply(state, chatSnapshot(RENDERER_EPOCH, 9))
    expect(chatTabIds(state)).toEqual(['codex-1'])
  })

  it('the host removal frame is the only thing that clears the cursor, and it is not modelled', () => {
    let state = emptyState()
    state = apply(state, chatSnapshot(RENDERER_EPOCH, 120))
    state = apply(state, emptySnapshot(RENDERER_EPOCH, 121))

    // orca-runtime-stored-mobile-snapshot-has-stale-preserved-tab.ts:132-142
    state = apply(state, {
      ...emptySnapshot(`removed:${(1).toString(36)}`, 0),
      removed: true
    } as RuntimeMobileSessionTabsResult)

    state = apply(state, chatSnapshot(RENDERER_EPOCH, 9))
    expect(chatTabIds(state)).toEqual(['codex-1'])
  })
})

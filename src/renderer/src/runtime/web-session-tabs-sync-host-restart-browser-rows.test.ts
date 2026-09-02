import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import {
  UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
  type RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { hostSnapshotAffirmsWorktreeContents } from './host-session-snapshot-authority'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

const WORKSPACE_ID = 'hosted-workspace'
const PAGE_ID = 'hosted-page'
const REMOTE_PAGE_ID = 'remote-page-1'
const URL = 'https://example.com/hosted'

const CLIENT_PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  pageHostGeneration: 1
}

const SERVER_PLACEMENT = { kind: 'server' as const }

function hostedWorkspace(): BrowserWorkspace {
  return {
    id: WORKSPACE_ID,
    worktreeId: WT,
    activePageId: PAGE_ID,
    pageIds: [PAGE_ID],
    url: URL,
    title: 'Hosted',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW - 1_000
  }
}

function hostedPage(): BrowserPage {
  return {
    id: PAGE_ID,
    workspaceId: WORKSPACE_ID,
    worktreeId: WT,
    url: URL,
    title: 'Hosted',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW - 1_000,
    browserRuntimeEnvironmentId: ENV
  }
}

function hostedUnifiedTab(): Tab {
  return {
    id: 'hosted-unified',
    entityId: WORKSPACE_ID,
    groupId: 'host-group-1',
    worktreeId: WT,
    contentType: 'browser',
    label: 'Hosted',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW - 1_000,
    isPreview: false,
    isPinned: false
  }
}

/**
 * A page the host already published once, so the staged/restored carve-outs are spent. This is the
 * steady state a live client is in when the runtime process restarts underneath it.
 */
function adoptedState(
  placement: WebSessionTabsSyncState['remoteBrowserPageHandlesByPageId'][string]['placement']
): WebSessionTabsSyncState {
  return makeState({
    activeBrowserTabId: WORKSPACE_ID,
    activeBrowserTabIdByWorktree: { [WT]: WORKSPACE_ID },
    activeTabType: 'browser',
    activeTabTypeByWorktree: { [WT]: 'browser' },
    browserTabsByWorktree: { [WT]: [hostedWorkspace()] },
    browserPagesByWorkspace: { [WORKSPACE_ID]: [hostedPage()] },
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: { environmentId: ENV, remotePageId: REMOTE_PAGE_ID, placement }
    },
    unifiedTabsByWorktree: { [WT]: [hostedUnifiedTab()] },
    groupsByWorktree: {
      [WT]: [
        {
          id: 'host-group-1',
          worktreeId: WT,
          activeTabId: 'hosted-unified',
          tabOrder: ['hosted-unified'],
          recentTabIds: ['hosted-unified']
        }
      ]
    }
  })
}

/** What a restarted runtime answers for a worktree it has published nothing for yet. */
function unpublishedWorktreeSnapshot(): RuntimeMobileSessionTabsResult {
  return makeSnapshot([], {
    publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
    snapshotVersion: 0,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null
  })
}

function applyToState(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(
    state,
    snapshot,
    ENV,
    NOW
  ) as Partial<WebSessionTabsSyncState>
  return { ...state, ...patch }
}

describe('client-hosted browser rows across a host restart', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  // Why: the guest is running on this desktop and outlived the runtime process, so an empty frame
  // from a runtime that has published nothing yet is not evidence the tab was closed.
  it('keeps a client-hosted row through an unpublished-worktree snapshot', () => {
    const next = applyToState(adoptedState(CLIENT_PLACEMENT), unpublishedWorktreeSnapshot())

    expect(next.browserTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([WORKSPACE_ID])
    expect(next.browserPagesByWorkspace[WORKSPACE_ID]?.map((page) => page.id)).toEqual([PAGE_ID])
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toBeDefined()
  })

  // The other half of the carve-out: a runtime that really did publish this worktree is answering,
  // and a page missing from that answer was closed.
  it('still culls a client-hosted row the host affirms is gone', () => {
    const next = applyToState(
      adoptedState(CLIENT_PLACEMENT),
      makeSnapshot([], { activeTabId: null, activeTabType: null })
    )

    expect(next.browserTabsByWorktree[WT]).toBeUndefined()
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toBeUndefined()
  })

  // The harder half: this frame is real. A restarted runtime rehydrated its terminals from disk and
  // published a versioned snapshot under a real epoch, so the worktree-level gate affirms it -- only
  // the flag says the browser rows in it are still incomplete.
  it('keeps a client-hosted row through a real frame flagged unreconciled', () => {
    const next = applyToState(
      adoptedState(CLIENT_PLACEMENT),
      makeSnapshot([], {
        activeTabId: null,
        activeTabType: null,
        clientHostedPagesUnreconciled: true
      })
    )

    expect(next.browserTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([WORKSPACE_ID])
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toBeDefined()
  })

  it('culls a server-hosted row from a frame flagged unreconciled', () => {
    const next = applyToState(
      adoptedState(SERVER_PLACEMENT),
      makeSnapshot([], {
        activeTabId: null,
        activeTabType: null,
        clientHostedPagesUnreconciled: true
      })
    )

    expect(next.browserTabsByWorktree[WT]).toBeUndefined()
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toBeUndefined()
  })

  // Why scoped to client-hosted: a server-placed page lives in the runtime process, so a restart
  // really did destroy it. Only a guest this desktop still runs can outlive the host.
  it('culls a server-hosted row on an unpublished-worktree snapshot', () => {
    const next = applyToState(adoptedState(SERVER_PLACEMENT), unpublishedWorktreeSnapshot())

    expect(next.browserTabsByWorktree[WT]).toBeUndefined()
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toBeUndefined()
  })
})

describe('reading whether a snapshot answers for a worktree', () => {
  // Pinned to the literal, not the constant: this string is the wire contract with hosts that
  // predate the constant, and a test written against the constant moves with it.
  it('treats the placeholder epoch at version zero as no answer', () => {
    expect(UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH).toBe('none')
    expect(
      hostSnapshotAffirmsWorktreeContents({ publicationEpoch: 'none', snapshotVersion: 0 })
    ).toBe(false)
  })

  // Both halves are load-bearing: a published worktree can legitimately sit at version zero, and
  // only the placeholder epoch marks a frame the runtime synthesized without consulting anything.
  it('answers for a real epoch even at version zero', () => {
    expect(
      hostSnapshotAffirmsWorktreeContents({ publicationEpoch: 'headless:abc', snapshotVersion: 0 })
    ).toBe(true)
  })

  it('answers for the placeholder epoch once it carries a version', () => {
    expect(
      hostSnapshotAffirmsWorktreeContents({ publicationEpoch: 'none', snapshotVersion: 1 })
    ).toBe(true)
  })
})

describe('scoping the carve-out to this environment', () => {
  const OTHER_ENV_PAGE_ID = 'other-env-page'

  /** A workspace holding a page of this environment plus one hosted for a different one. */
  function mixedEnvironmentState(): WebSessionTabsSyncState {
    const state = adoptedState(SERVER_PLACEMENT)
    return {
      ...state,
      browserTabsByWorktree: {
        [WT]: [{ ...hostedWorkspace(), pageIds: [PAGE_ID, OTHER_ENV_PAGE_ID] }]
      },
      browserPagesByWorkspace: {
        [WORKSPACE_ID]: [
          hostedPage(),
          { ...hostedPage(), id: OTHER_ENV_PAGE_ID, browserRuntimeEnvironmentId: 'env-other' }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        ...state.remoteBrowserPageHandlesByPageId,
        [OTHER_ENV_PAGE_ID]: {
          environmentId: 'env-other',
          remotePageId: 'remote-other',
          placement: CLIENT_PLACEMENT
        }
      }
    }
  }

  // Why: the carve-out asks whether THIS desktop hosts a page of the environment that is speaking.
  // A guest hosted for some other environment says nothing about this one's silence.
  it('does not let a page of another environment hold the row', () => {
    const next = applyToState(mixedEnvironmentState(), unpublishedWorktreeSnapshot())

    expect(next.browserTabsByWorktree[WT]).toBeUndefined()
  })
})

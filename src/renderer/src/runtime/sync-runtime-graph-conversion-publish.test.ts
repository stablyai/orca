import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '../lib/agent-status'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'

vi.mock('@/lib/doc-preview-grants', () => ({
  releaseDocPreviewGrant: vi.fn(),
  ensureDocPreviewGrant: vi.fn(),
  buildDocPreviewGrantRequest: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const WORKTREE_ID = 'repo1::/path/wt1'
const DOC_LOCATION = {
  kind: 'workspace-doc' as const,
  worktreeId: WORKTREE_ID,
  filePath: '/home/alice/wt1/report/index.html'
}

function createStoreWithWorktree(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WORKTREE_ID
  })
  return store
}

function worktreeSnapshot(
  store: ReturnType<typeof createTestStore>
): ReturnType<typeof buildMobileSessionTabSnapshots>[number] | undefined {
  return buildMobileSessionTabSnapshots(store.getState()).find(
    (entry) => entry.worktree === WORKTREE_ID
  )
}

function publishedBrowserWorkspaceIds(store: ReturnType<typeof createTestStore>): string[] {
  return (worktreeSnapshot(store)?.tabs ?? [])
    .filter((tab) => tab.type === 'browser')
    .map((tab) => (tab as { browserWorkspaceId?: string }).browserWorkspaceId ?? '')
}

function collectLayoutGroupIds(node: unknown, into: string[] = []): string[] {
  if (!node || typeof node !== 'object') {
    return into
  }
  const candidate = node as { type?: string; groupId?: string; first?: unknown; second?: unknown }
  if (candidate.type === 'leaf' && candidate.groupId) {
    into.push(candidate.groupId)
    return into
  }
  collectLayoutGroupIds(candidate.first, into)
  collectLayoutGroupIds(candidate.second, into)
  return into
}

/** The mechanical invariant across all three observables: nothing a published group or the layout
 *  names may be missing from the published tab list, whatever was held back and why. */
function expectGroupsAndLayoutConsistent(store: ReturnType<typeof createTestStore>): void {
  const snapshot = worktreeSnapshot(store)
  const publishedTabIds = new Set((snapshot?.tabs ?? []).map((tab) => tab.id))
  for (const group of snapshot?.tabGroups ?? []) {
    expect(group.tabOrder.filter((tabId) => !publishedTabIds.has(tabId))).toEqual([])
    expect((group.recentTabIds ?? []).filter((tabId) => !publishedTabIds.has(tabId))).toEqual([])
    expect(group.activeTabId === null || publishedTabIds.has(group.activeTabId)).toBe(true)
  }
  const groupIds = new Set((snapshot?.tabGroups ?? []).map((group) => group.id))
  for (const layoutGroupId of collectLayoutGroupIds(snapshot?.tabGroupLayout)) {
    expect(groupIds.has(layoutGroupId)).toBe(true)
  }
}

function publishedUnifiedTabIds(store: ReturnType<typeof createTestStore>): Set<string> {
  return new Set((worktreeSnapshot(store)?.tabs ?? []).map((tab) => tab.id))
}

// The publish boundary is a predicate over docLocation, so a conversion must flip it in the same
// store commit that flips the page — no intermediate state may publish a document or hold back a
// web page. Driven through the real store actions, not a hand-built state, so the mirror path the
// conversion writes is the one the publisher reads.
describe('mobile publish across an address-bar conversion', () => {
  it('starts publishing a doc tab the moment it converts to web, and stops on the way back', () => {
    const store = createStoreWithWorktree()
    // Presence precondition: an ordinary URL tab publishes throughout, so an empty answer would
    // fail rather than pass by the publisher being broken for browser tabs entirely.
    const urlTab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    const docTab = store.getState().createBrowserTab(WORKTREE_ID, '', {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null
    })
    const docPageId = store.getState().browserPagesByWorkspace[docTab.id]?.[0]?.id ?? ''

    expect(publishedBrowserWorkspaceIds(store)).toEqual([urlTab.id])

    const webPage = store.getState().convertBrowserPage(docPageId, {
      kind: 'web',
      url: 'https://converted.example/'
    })
    expect(webPage).not.toBeNull()
    expect(publishedBrowserWorkspaceIds(store).sort()).toEqual([urlTab.id, docTab.id].sort())

    const docPage = store.getState().convertBrowserPage(webPage?.id ?? '', {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })
    expect(docPage).not.toBeNull()
    expect(publishedBrowserWorkspaceIds(store)).toEqual([urlTab.id])
  })

  // Why groups and the layout are driven separately: the group projection was the historically
  // untested half of the publish boundary, and a doc tab surviving in a group's tabOrder names a
  // tab the phone is never sent.
  it('holds the doc tab out of published groups and the layout, and admits it on conversion', () => {
    const store = createStoreWithWorktree()
    const urlTab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    // The doc tab gets a split group of its own, so holding it back must also take its group out
    // of the projection AND its leaf out of the layout — the observable no earlier test drove.
    const sourceGroupId = store.getState().activeGroupIdByWorktree[WORKTREE_ID] ?? ''
    expect(sourceGroupId).not.toBe('')
    const splitGroupId = store.getState().createEmptySplitGroup(WORKTREE_ID, sourceGroupId, 'right')
    expect(splitGroupId).not.toBeNull()
    const docTab = store.getState().createBrowserTab(WORKTREE_ID, '', {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null,
      targetGroupId: splitGroupId ?? undefined
    })
    const docPageId = store.getState().browserPagesByWorkspace[docTab.id]?.[0]?.id ?? ''
    const docUnifiedTabId =
      (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).find(
        (tab) => tab.contentType === 'browser' && tab.entityId === docTab.id
      )?.id ?? ''
    const urlUnifiedTabId =
      (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).find(
        (tab) => tab.contentType === 'browser' && tab.entityId === urlTab.id
      )?.id ?? ''
    expect(docUnifiedTabId).not.toBe('')

    const publishedGroupIds = (): Set<string> =>
      new Set((worktreeSnapshot(store)?.tabGroups ?? []).map((group) => group.id))
    const layoutGroupIds = (): string[] =>
      collectLayoutGroupIds(worktreeSnapshot(store)?.tabGroupLayout)

    // Presence half: the URL tab's unified id is published; the doc tab's is not, and neither the
    // group projection nor the layout tree names the split the doc tab sits alone in.
    expect(publishedUnifiedTabIds(store).has(urlUnifiedTabId)).toBe(true)
    expect(publishedUnifiedTabIds(store).has(docUnifiedTabId)).toBe(false)
    expect(publishedGroupIds().has(sourceGroupId)).toBe(true)
    expect(publishedGroupIds().has(splitGroupId ?? '')).toBe(false)
    expect(layoutGroupIds()).toEqual([sourceGroupId])
    expectGroupsAndLayoutConsistent(store)

    const webPage = store.getState().convertBrowserPage(docPageId, {
      kind: 'web',
      url: 'https://converted.example/'
    })
    expect(webPage).not.toBeNull()
    expect(publishedUnifiedTabIds(store).has(docUnifiedTabId)).toBe(true)
    expect(publishedGroupIds().has(splitGroupId ?? '')).toBe(true)
    expect(layoutGroupIds().sort()).toEqual([sourceGroupId, splitGroupId ?? ''].sort())
    expectGroupsAndLayoutConsistent(store)

    const docPage = store.getState().convertBrowserPage(webPage?.id ?? '', {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })
    expect(docPage).not.toBeNull()
    expect(publishedUnifiedTabIds(store).has(docUnifiedTabId)).toBe(false)
    expect(publishedGroupIds().has(splitGroupId ?? '')).toBe(false)
    expect(layoutGroupIds()).toEqual([sourceGroupId])
    expectGroupsAndLayoutConsistent(store)
  })
})

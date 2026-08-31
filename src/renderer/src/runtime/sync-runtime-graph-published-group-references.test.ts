import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { AppState } from '../store/types'

// The invariant these share: the mobile snapshot may not publish an id that names something it did
// not publish. Held-back tabs already drag their group out of `tabGroups`; these pin that the
// snapshot's own `activeGroupId` and `tabGroupLayout` follow the group out rather than pointing at
// a group the phone was never sent.

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

/** Published ids that name a tab group the snapshot never published — empty is the invariant. */
function danglingGroupRefs(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
): (string | null)[] {
  const publishedGroupIds = new Set((snapshot?.tabGroups ?? []).map((group) => group.id))
  return [
    snapshot?.activeGroupId ?? null,
    ...collectLayoutGroupIds(snapshot?.tabGroupLayout)
  ].filter((groupId) => groupId !== null && !publishedGroupIds.has(groupId))
}

describe('buildMobileSessionTabSnapshots published group references', () => {
  // Why groups get their own fixture: 'omits a browser tab located by a workspace document from
  // mobile snapshots' (in sync-runtime-graph-editor-diff-tabs.test.ts) drives the same document
  // through the legacy nav order, where the per-tab guard is the only thing holding it back. With
  // groups the projection runs first and publishes group metadata of its own, so a document reaching
  // it leaves a group whose tabOrder and activeTabId name a tab the phone is never sent.
  it('keeps a workspace document out of published tab groups as well as the tab list', () => {
    const docWorkspaceId = 'browser-doc'
    const urlWorkspaceId = 'browser-url'
    const state = makeState({
      // The document's group is the active one: if it survived anywhere, this is where it shows.
      activeGroupIdByWorktree: { 'wt-1': 'group-left' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'unified-doc',
            tabOrder: ['unified-doc'],
            recentTabIds: ['unified-doc']
          },
          {
            id: 'group-right',
            activeTabId: 'unified-url',
            tabOrder: ['unified-url'],
            recentTabIds: ['unified-url']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-doc',
            groupId: 'group-left',
            contentType: 'browser',
            entityId: docWorkspaceId,
            title: 'report.html'
          },
          {
            id: 'unified-url',
            groupId: 'group-right',
            contentType: 'browser',
            entityId: urlWorkspaceId,
            title: 'Example'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: docWorkspaceId,
            worktreeId: 'wt-1',
            activePageId: 'page-doc',
            pageIds: ['page-doc'],
            url: 'data:text/html,',
            title: 'report.html',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1,
            docLocation: {
              kind: 'workspace-doc',
              worktreeId: 'wt-1',
              filePath: '/repo/docs/report.html'
            }
          },
          {
            id: urlWorkspaceId,
            worktreeId: 'wt-1',
            activePageId: 'page-url',
            pageIds: ['page-url'],
            url: 'https://example.com/',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 2
          }
        ]
      }
    } as unknown as Parameters<typeof makeState>[0])

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    // The presence half: the grouped URL tab beside it does publish, so a projection that had
    // stopped emitting browser tabs — or groups — fails here rather than passing on emptiness.
    expect(snapshot?.tabs).toMatchObject([{ type: 'browser', browserWorkspaceId: urlWorkspaceId }])
    expect(snapshot?.tabGroups).toMatchObject([{ id: 'group-right', tabOrder: ['unified-url'] }])
    // Mechanical rather than by name: nothing a group points at may be missing from the tab list,
    // whatever the reason it was held back.
    const publishedTabIds = new Set(snapshot?.tabs.map((tab) => tab.id) ?? [])
    for (const group of snapshot?.tabGroups ?? []) {
      expect(group.tabOrder.filter((tabId) => !publishedTabIds.has(tabId))).toEqual([])
      expect((group.recentTabIds ?? []).filter((tabId) => !publishedTabIds.has(tabId))).toEqual([])
      expect(group.activeTabId === null || publishedTabIds.has(group.activeTabId)).toBe(true)
    }
    expect(snapshot?.activeTabId === null || publishedTabIds.has(snapshot.activeTabId)).toBe(true)
    // The same claim one level up: the snapshot's own active-group pointer may not name a group the
    // phone was never sent. 'group-left' is the held-back one, so a pass-through of the desktop's
    // active group fails here.
    expect(danglingGroupRefs(snapshot)).toEqual([])
    // What the reader would actually see go wrong: a group held back has to leave the layout tree
    // with it, or the phone renders a split whose pane can never have anything in it.
    expect(collectLayoutGroupIds(snapshot?.tabGroupLayout)).toEqual(['group-right'])
  })

  // Why a second fixture for the same claim: the test above holds a group back over a browser
  // document, which is one guard. A combined-diff tab is held back by an unrelated one, so a fix
  // written against either guard alone still leaves the other publishing a group id it withheld.
  it('does not name a held-back combined-diff group as the active group', () => {
    const combinedId = 'wt-1::all-diffs::branch::main'
    const state = makeState({
      // The desktop's active group is the one holding only the combined diff.
      activeGroupIdByWorktree: { 'wt-1': 'group-left' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'combined-tab',
            tabOrder: ['combined-tab'],
            recentTabIds: ['combined-tab']
          },
          {
            id: 'group-right',
            activeTabId: 'editor-tab',
            tabOrder: ['editor-tab'],
            recentTabIds: ['editor-tab']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'combined-tab',
            groupId: 'group-left',
            contentType: 'diff',
            entityId: combinedId,
            title: 'Branch Changes (main)'
          },
          {
            id: 'editor-tab',
            groupId: 'group-right',
            contentType: 'editor',
            entityId: '/repo/src/app.ts',
            title: 'app.ts'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: [
        {
          id: combinedId,
          filePath: '/repo',
          relativePath: 'Branch Changes (main)',
          worktreeId: 'wt-1',
          language: 'plaintext',
          mode: 'diff',
          diffSource: 'combined-branch',
          isDirty: false
        },
        {
          id: '/repo/src/app.ts',
          filePath: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    // The presence half: the ordinary editor beside it does publish, so a projection that had
    // stopped emitting groups fails here rather than passing on emptiness.
    expect(snapshot?.tabs.map((tab) => tab.id)).toEqual(['editor-tab'])
    expect(snapshot?.tabGroups?.map((group) => group.id)).toEqual(['group-right'])
    expect(danglingGroupRefs(snapshot)).toEqual([])
    // The display choice, by name: focus lands on the group the phone actually has.
    expect(snapshot?.activeGroupId).toBe('group-right')
  })

  it('does not recover unsupported combined diff tabs through split-group fallback', () => {
    const combinedId = 'wt-1::all-diffs::branch::main'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-right' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-right',
            activeTabId: 'combined-tab-right',
            tabOrder: [],
            recentTabIds: []
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'combined-tab-right',
            groupId: 'group-right',
            contentType: 'diff',
            entityId: combinedId,
            title: 'Branch Changes (main)'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: [
        {
          id: combinedId,
          filePath: '/repo',
          relativePath: 'Branch Changes (main)',
          worktreeId: 'wt-1',
          language: 'plaintext',
          mode: 'diff',
          diffSource: 'combined-branch',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toEqual([])
    expect(snapshot?.tabGroups).toBeUndefined()
    // Nothing was published, so there is no group left to point at.
    expect(danglingGroupRefs(snapshot)).toEqual([])
    expect(snapshot?.activeGroupId).toBeNull()
  })
})

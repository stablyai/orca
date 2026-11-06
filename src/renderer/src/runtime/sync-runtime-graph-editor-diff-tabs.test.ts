import { describe, expect, it } from 'vitest'
import '../../../shared/layout-owner-switch'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '../store/types'

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

describe('buildMobileSessionTabSnapshots', () => {
  // Legacy navigation tests only per-tab guards; grouped projection must also remove metadata referencing withheld document tabs.
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

    // Require grouped URL output so broken browser/group publishing cannot pass vacuously.
    expect(snapshot?.tabs).toMatchObject([{ type: 'browser', browserWorkspaceId: urlWorkspaceId }])
    expect(snapshot?.tabGroups).toMatchObject([{ id: 'group-right', tabOrder: ['unified-url'] }])
    // Every published group reference must exist in published tab list, whatever caused exclusion.
    const publishedTabIds = new Set(snapshot?.tabs.map((tab) => tab.id) ?? [])
    for (const group of snapshot?.tabGroups ?? []) {
      expect(group.tabOrder.filter((tabId) => !publishedTabIds.has(tabId))).toEqual([])
      expect((group.recentTabIds ?? []).filter((tabId) => !publishedTabIds.has(tabId))).toEqual([])
      expect(group.activeTabId === null || publishedTabIds.has(group.activeTabId)).toBe(true)
    }
    expect(snapshot?.activeTabId === null || publishedTabIds.has(snapshot.activeTabId)).toBe(true)
    // Withheld groups must also leave layout tree or mobile renders empty splits.
    expect(collectLayoutGroupIds(snapshot?.tabGroupLayout)).toEqual(['group-right'])
  })

  it('publishes a missing non-markdown editor with its unified tab id and split group', () => {
    const fileId = '/repo/src/app.ts'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-left' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'browser-tab-1',
            tabOrder: ['browser-tab-1'],
            recentTabIds: ['browser-tab-1']
          },
          {
            id: 'group-right',
            activeTabId: 'editor-tab-1',
            tabOrder: [],
            recentTabIds: []
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
            id: 'browser-tab-1',
            groupId: 'group-left',
            contentType: 'browser',
            entityId: 'browser-1',
            title: 'Docs'
          },
          {
            id: 'editor-tab-1',
            groupId: 'group-right',
            contentType: 'editor',
            entityId: fileId,
            title: 'app.ts'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-1',
            worktreeId: 'wt-1',
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.test',
            title: 'Docs',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as unknown as AppState['browserTabsByWorktree'],
      browserPagesByWorkspace: {
        'browser-1': [
          {
            id: 'page-1',
            workspaceId: 'browser-1',
            worktreeId: 'wt-1',
            url: 'https://example.test',
            title: 'Docs',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as unknown as AppState['browserPagesByWorkspace'],
      openFiles: [
        {
          id: fileId,
          filePath: fileId,
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs.map((tab) => tab.id)).toEqual(['browser-tab-1', 'editor-tab-1'])
    expect(snapshot?.tabs.at(-1)).toMatchObject({
      type: 'file',
      id: 'editor-tab-1',
      relativePath: 'src/app.ts',
      isActive: false
    })
    expect(snapshot?.activeTabId).toBe('browser-tab-1')
    expect(snapshot?.tabGroups).toEqual([
      {
        id: 'group-left',
        activeTabId: 'browser-tab-1',
        tabOrder: ['browser-tab-1'],
        recentTabIds: ['browser-tab-1']
      },
      {
        id: 'group-right',
        activeTabId: 'editor-tab-1',
        tabOrder: ['editor-tab-1'],
        recentTabIds: []
      }
    ])
    expect(snapshot?.tabGroupLayout).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    })
  })

  it('recovers a duplicate split editor tab for an already-emitted file id', () => {
    const fileId = '/repo/src/app.ts'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-left' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'editor-left',
            tabOrder: ['editor-left'],
            recentTabIds: ['editor-left']
          },
          {
            id: 'group-right',
            activeTabId: 'editor-right',
            tabOrder: [],
            recentTabIds: []
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
            id: 'editor-left',
            groupId: 'group-left',
            contentType: 'editor',
            entityId: fileId,
            title: 'app.ts'
          },
          {
            id: 'editor-right',
            groupId: 'group-right',
            contentType: 'editor',
            entityId: fileId,
            title: 'app.ts'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: [
        {
          id: fileId,
          filePath: fileId,
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toMatchObject([
      { type: 'file', id: 'editor-left', relativePath: 'src/app.ts' },
      { type: 'file', id: 'editor-right', relativePath: 'src/app.ts' }
    ])
    expect(snapshot?.tabGroups).toEqual([
      {
        id: 'group-left',
        activeTabId: 'editor-left',
        tabOrder: ['editor-left'],
        recentTabIds: ['editor-left']
      },
      {
        id: 'group-right',
        activeTabId: 'editor-right',
        tabOrder: ['editor-right'],
        recentTabIds: []
      }
    ])
    expect(snapshot?.tabGroupLayout).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    })
  })

  it('keeps duplicate file ids scoped to their worktree', () => {
    const sharedRemotePath = '/home/dev/project/README.md'
    const previewId = `markdown-preview::${sharedRemotePath}`
    const state = makeState({
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: {
        'wt-1': [sharedRemotePath, previewId],
        'wt-2': [sharedRemotePath]
      },
      openFiles: [
        {
          id: sharedRemotePath,
          filePath: sharedRemotePath,
          relativePath: 'docs/wt-one.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          mode: 'edit',
          isDirty: true
        },
        {
          id: sharedRemotePath,
          filePath: sharedRemotePath,
          relativePath: 'docs/wt-two.md',
          worktreeId: 'wt-2',
          language: 'markdown',
          mode: 'edit',
          isDirty: false
        },
        {
          id: previewId,
          filePath: sharedRemotePath,
          relativePath: 'docs/wt-one.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          mode: 'markdown-preview',
          markdownPreviewSourceFileId: sharedRemotePath,
          isDirty: false
        }
      ]
    })

    const snapshotsByWorktree = new Map(
      buildMobileSessionTabSnapshots(state).map((snapshot) => [snapshot.worktree, snapshot])
    )

    expect(snapshotsByWorktree.get('wt-1')?.tabs).toMatchObject([
      { type: 'markdown', title: 'wt-one.md', sourceRelativePath: 'docs/wt-one.md' },
      { type: 'markdown', title: 'wt-one.md', sourceRelativePath: 'docs/wt-one.md' }
    ])
    expect(snapshotsByWorktree.get('wt-2')?.tabs).toMatchObject([
      { type: 'markdown', title: 'wt-two.md', sourceRelativePath: 'docs/wt-two.md' }
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
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
  it('preserves source-control diff metadata for mobile file tabs', () => {
    const diffId = 'wt-1::diff::unstaged::src/app.ts'
    const state = makeState({
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: { 'wt-1': [diffId] },
      openFiles: [
        {
          id: diffId,
          filePath: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'diff',
          diffSource: 'unstaged',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toMatchObject([
      {
        type: 'file',
        id: diffId,
        mode: 'diff',
        diffSource: 'unstaged',
        relativePath: 'src/app.ts'
      }
    ])
  })

  it('omits unsupported branch and commit diff metadata from mobile file tabs', () => {
    const diffId = 'wt-1::diff::branch::src/app.ts'
    const state = makeState({
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: { 'wt-1': [diffId] },
      openFiles: [
        {
          id: diffId,
          filePath: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'diff',
          diffSource: 'branch',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]
    const tab = snapshot?.tabs[0]

    expect(tab).toMatchObject({ type: 'file', mode: 'diff', relativePath: 'src/app.ts' })
    expect(tab).not.toHaveProperty('diffSource')
  })

  it.each([
    ['combined-branch', 'wt-1::all-diffs::branch::main', 'Branch Changes (main)'],
    ['combined-commit', 'wt-1::all-diffs::commit::abc123', 'Commit abc123'],
    ['combined-all', 'wt-1::all-diffs::uncommitted', 'All Changes'],
    ['combined-uncommitted', 'wt-1::all-diffs::uncommitted::unstaged', 'Changes']
  ] as const)('omits unsupported %s diff tabs from mobile file snapshots', (source, id, label) => {
    const state = makeState({
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: { 'wt-1': [id] },
      activeFileId: id,
      activeFileIdByWorktree: { 'wt-1': id },
      activeTabType: 'editor',
      activeTabTypeByWorktree: { 'wt-1': 'editor' },
      openFiles: [
        {
          id,
          filePath: '/repo',
          relativePath: label,
          worktreeId: 'wt-1',
          language: 'plaintext',
          mode: 'diff',
          diffSource: source,
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toEqual([])
    expect(snapshot?.activeTabId).toBeNull()
    expect(snapshot?.activeTabType).toBeNull()
  })

  // Why held back: a workspace document is served to one desktop guest through a grant no mobile
  // client holds, and the wire has no tab kind for it — an old client would take it for an ordinary
  // browser tab and offer navigation for a page that has no URL.
  it('omits a browser tab located by a workspace document from mobile snapshots', () => {
    const docWorkspaceId = 'browser-doc'
    const urlWorkspaceId = 'browser-url'
    const state = makeState({
      tabBarOrderByWorktree: { 'wt-1': [docWorkspaceId, urlWorkspaceId] },
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

    // The presence half: the ordinary browser tab beside it does publish, so a filter that dropped
    // every browser tab — or a publisher that had stopped emitting them — fails here rather than
    // passing on an empty list.
    expect(snapshot?.tabs).toMatchObject([{ type: 'browser', browserWorkspaceId: urlWorkspaceId }])
  })

  // Why the same claim is driven again through tab groups: the test above takes the legacy nav
  // order, where the only thing that has to hold the document back is the per-tab guard. With
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
    // What the reader would actually see go wrong: a group held back has to leave the layout tree
    // with it, or the phone renders a split whose pane can never have anything in it.
    expect(collectLayoutGroupIds(snapshot?.tabGroupLayout)).toEqual(['group-right'])
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

  it('does not conflate same-path edit and diff editor tabs in the fallback', () => {
    const fileId = '/repo/src/app.ts'
    const diffId = 'wt-1::diff::unstaged::src/app.ts'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'editor-tab-1',
            tabOrder: ['editor-tab-1'],
            recentTabIds: ['editor-tab-1']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'editor-tab-1',
            groupId: 'group-1',
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
        },
        {
          id: diffId,
          filePath: fileId,
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'diff',
          diffSource: 'unstaged',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toMatchObject([
      { type: 'file', id: 'editor-tab-1', mode: 'edit', relativePath: 'src/app.ts' },
      { type: 'file', id: diffId, mode: 'diff', diffSource: 'unstaged', relativePath: 'src/app.ts' }
    ])
    expect(snapshot?.tabGroups).toEqual([
      {
        id: 'group-1',
        activeTabId: 'editor-tab-1',
        tabOrder: ['editor-tab-1', diffId],
        recentTabIds: ['editor-tab-1']
      }
    ])
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

  it('uses unified editor ids in legacy no-group order without duplicating file ids', () => {
    const fileId = '/repo/src/app.ts'
    const state = makeState({
      tabBarOrderByWorktree: { 'wt-1': [fileId] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'editor-tab-1',
            groupId: 'group-1',
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
      { type: 'file', id: 'editor-tab-1', relativePath: 'src/app.ts' }
    ])
    expect(snapshot?.tabs).toHaveLength(1)
  })

  it('recovers a missing diff unified tab in its split group', () => {
    const diffId = 'wt-1::diff::unstaged::src/app.ts'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-left' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'terminal-left',
            tabOrder: [],
            recentTabIds: []
          },
          {
            id: 'group-right',
            activeTabId: 'diff-tab-right',
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
            id: 'diff-tab-right',
            groupId: 'group-right',
            contentType: 'diff',
            entityId: diffId,
            title: 'app.ts'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: [
        {
          id: diffId,
          filePath: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'diff',
          diffSource: 'unstaged',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toMatchObject([
      {
        type: 'file',
        id: 'diff-tab-right',
        mode: 'diff',
        diffSource: 'unstaged',
        relativePath: 'src/app.ts'
      }
    ])
    expect(snapshot?.tabGroups).toEqual([
      {
        id: 'group-right',
        activeTabId: 'diff-tab-right',
        tabOrder: ['diff-tab-right'],
        recentTabIds: []
      }
    ])
    expect(snapshot?.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'group-right' })
  })

  it('gates fallback editor active state on the worktree active tab type', () => {
    const fileId = '/repo/src/app.ts'
    const state = {
      activeFileId: '/repo/other-worktree.ts',
      activeFileIdByWorktree: { 'wt-1': fileId },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: fileId,
            tabOrder: [],
            recentTabIds: []
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
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
    } satisfies Partial<AppState>

    const terminalSnapshot = buildMobileSessionTabSnapshots(
      makeState({
        ...state,
        activeTabTypeByWorktree: { 'wt-1': 'terminal' }
      })
    )[0]
    const editorSnapshot = buildMobileSessionTabSnapshots(
      makeState({
        ...state,
        activeTabTypeByWorktree: { 'wt-1': 'editor' }
      })
    )[0]

    expect(terminalSnapshot?.tabs).toMatchObject([
      { type: 'file', id: fileId, relativePath: 'src/app.ts', isActive: false }
    ])
    expect(terminalSnapshot?.activeTabId).toBeNull()
    expect(terminalSnapshot?.activeTabType).toBeNull()
    expect(editorSnapshot?.tabs).toMatchObject([
      { type: 'file', id: fileId, relativePath: 'src/app.ts', isActive: true }
    ])
    expect(editorSnapshot?.activeTabId).toBe(fileId)
    expect(editorSnapshot?.activeTabType).toBe('file')
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

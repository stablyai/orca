import { describe, expect, it } from 'vitest'
import { createTestStore } from '../store-test-helpers'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import type { WorkspaceDocHistoryEntry } from '../../../../../shared/workspace-doc-history'

describe('createBrowserHistoryActions', () => {
  it('removes an entry from browserUrlHistory by exact url or normalized form', () => {
    const store = createTestStore()
    const entry1: BrowserHistoryEntry = {
      url: 'https://example.com/page1',
      normalizedUrl: 'https://example.com/page1',
      title: 'Page 1',
      lastVisitedAt: 1000,
      visitCount: 1
    }
    const entry2: BrowserHistoryEntry = {
      url: 'https://example.com/page2',
      normalizedUrl: 'https://example.com/page2',
      title: 'Page 2',
      lastVisitedAt: 2000,
      visitCount: 2
    }

    store.setState({ browserUrlHistory: [entry1, entry2] })
    expect(store.getState().browserUrlHistory).toHaveLength(2)

    store.getState().removeBrowserHistoryEntry('https://example.com/page1')
    expect(store.getState().browserUrlHistory).toEqual([entry2])
  })

  it('removes an entry from workspaceDocHistory by filePath', () => {
    const store = createTestStore()
    const doc1: WorkspaceDocHistoryEntry = {
      docLocation: {
        kind: 'workspace-doc',
        worktreeId: 'wt-1',
        filePath: '/path/to/doc1.md'
      },
      title: 'Doc 1',
      lastVisitedAt: 1000,
      visitCount: 1
    }
    const doc2: WorkspaceDocHistoryEntry = {
      docLocation: {
        kind: 'workspace-doc',
        worktreeId: 'wt-1',
        filePath: '/path/to/doc2.md'
      },
      title: 'Doc 2',
      lastVisitedAt: 2000,
      visitCount: 2
    }

    store.setState({ workspaceDocHistory: [doc1, doc2] })
    expect(store.getState().workspaceDocHistory).toHaveLength(2)

    store.getState().removeBrowserHistoryEntry('/path/to/doc1.md')
    expect(store.getState().workspaceDocHistory).toEqual([doc2])
  })

  it('clears both browserUrlHistory and workspaceDocHistory on clearBrowserHistory', () => {
    const store = createTestStore()
    const entry: BrowserHistoryEntry = {
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      title: 'Example',
      lastVisitedAt: 1000,
      visitCount: 1
    }
    const doc: WorkspaceDocHistoryEntry = {
      docLocation: {
        kind: 'workspace-doc',
        worktreeId: 'wt-1',
        filePath: '/path/to/doc.md'
      },
      title: 'Doc',
      lastVisitedAt: 1000,
      visitCount: 1
    }

    store.setState({
      browserUrlHistory: [entry],
      workspaceDocHistory: [doc]
    })

    store.getState().clearBrowserHistory()
    expect(store.getState().browserUrlHistory).toEqual([])
    expect(store.getState().workspaceDocHistory).toEqual([])
  })
})

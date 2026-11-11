import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'
import { makeState } from './testing/sync-runtime-graph-test-harness'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { describe, expect, it } from 'vitest'
import { buildBrowserPageInventory } from './browser-page-inventory'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'

const workspace: BrowserWorkspace = {
  id: 'workspace',
  worktreeId: 'worktree',
  title: 'Legacy',
  url: 'https://legacy.example/',
  activePageId: 'legacy',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  faviconUrl: null,
  loadError: null,
  createdAt: 1
}
function page(id: string, updates: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id,
    workspaceId: workspace.id,
    worktreeId: 'worktree',
    title: id,
    url: `https://example.com/${id}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    loadError: null,
    createdAt: 1,
    ...updates
  }
}
describe('saved browser inventory ownership', () => {
  it.each(['server', null])('keeps explicit local pages with inferred owner %s', (owner) => {
    const result = buildBrowserPageInventory({
      browserWorkspaces: [workspace],
      browserRuntimeEnvironmentId: owner,
      pagesByBrowserWorkspaceId: new Map([
        [
          workspace.id,
          [
            page('inherited'),
            page('remote', { browserRuntimeEnvironmentId: 'server' }),
            page('local', { browserRuntimeEnvironmentId: null }),
            page('document', {
              browserRuntimeEnvironmentId: null,
              docLocation: {
                kind: 'workspace-doc',
                worktreeId: 'worktree',
                filePath: '/tmp/doc.html'
              }
            })
          ]
        ]
      ]),
      certificateFailureByBrowserPageId: new Map()
    })
    expect(result.map((entry) => entry.browserPageId)).toEqual(
      owner === null ? ['inherited', 'local'] : ['local']
    )
  })

  it('matches the pane local fallback for inherited pages in a non-active twin folder', () => {
    const folder = {
      id: 'twinned',
      projectGroupId: 'group',
      name: 'Twin',
      folderPath: '/tmp/twin',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    const state = makeState({
      folderWorkspaces: [
        { ...folder, executionHostId: 'local' },
        { ...folder, executionHostId: 'runtime:other' }
      ],
      browserTabsByWorktree: {
        'folder:twinned': [
          {
            ...workspace,
            worktreeId: 'folder:twinned',
            activePageId: 'C',
            pageIds: ['A', 'B', 'C']
          }
        ]
      },
      browserPagesByWorkspace: {
        [workspace.id]: ['A', 'B', 'C'].map((id) => page(id, { worktreeId: 'folder:twinned' }))
      }
    })
    expect(
      runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: 'folder:twinned' }).kind
    ).toBe('ambiguous')
    const snapshots = buildMobileSessionTabSnapshots(state, false)
    expect(snapshots[0]?.browserPageInventory?.map((entry) => entry.browserPageId)).toEqual([
      'A',
      'B',
      'C'
    ])
  })

  it('retains the existing legacy identity without inventing modern membership', () => {
    const input = {
      browserWorkspaces: [workspace],
      browserRuntimeEnvironmentId: null,
      pagesByBrowserWorkspaceId: new Map(),
      certificateFailureByBrowserPageId: new Map()
    }
    expect(buildBrowserPageInventory(input)).toEqual([
      {
        browserPageId: 'legacy',
        browserWorkspaceId: 'workspace',
        title: 'Legacy',
        url: 'https://legacy.example/',
        profileId: null,
        loadError: null,
        certificateFailure: null
      }
    ])
    expect(
      buildBrowserPageInventory({ ...input, browserWorkspaces: [{ ...workspace, pageIds: [] }] })
    ).toEqual([])
    expect(buildBrowserPageInventory({ ...input, browserRuntimeEnvironmentId: 'server' })).toEqual(
      []
    )
  })
})

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
  it.each(['server', undefined])('keeps explicit local pages with inferred owner %s', (owner) => {
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
    expect(result.map((entry) => entry.browserPageId)).toEqual(['local'])
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

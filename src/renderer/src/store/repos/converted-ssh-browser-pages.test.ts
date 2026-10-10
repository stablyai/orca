import { describe, expect, it } from 'vitest'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import type { WorktreeRuntimeOwnerState } from '../../lib/worktree-runtime-owner'
import { buildBrowserPage } from '../slices/browser-page-records'
import { preserveConvertedSshBrowserPages } from './converted-ssh-browser-pages'

const owners: WorktreeRuntimeOwnerState = {
  repos: [{ id: 'repo', connectionId: 'target', executionHostId: 'ssh:target' }],
  worktreesByRepo: { repo: [{ id: 'worktree', repoId: 'repo', hostId: 'ssh:target' }] },
  folderWorkspaces: [{ id: 'folder', projectGroupId: 'group' }],
  projectGroups: [{ id: 'group', connectionId: 'target' }]
}

function page(worktreeId = 'worktree'): BrowserPage {
  return buildBrowserPage('browser', worktreeId, 'https://private.invalid/', 'Private')
}

describe('desktop browser placement during SSH conversion', () => {
  it('pins all inherited pages to desktop without changing their saved browser state', () => {
    const pages = [page(), page()]
    const before = { ...owners, browserPagesByWorkspace: { browser: pages } }
    const after = preserveConvertedSshBrowserPages(before, 'target')
    expect(after.browser).toEqual(
      pages.map((original) => ({ ...original, browserRuntimeEnvironmentId: null }))
    )
    expect(pages.every((original) => original.browserRuntimeEnvironmentId === undefined)).toBe(true)
    expect(
      preserveConvertedSshBrowserPages({ ...before, browserPagesByWorkspace: after }, 'target')
    ).toBe(after)
  })

  it('also preserves pages in SSH-owned folder workspaces', () => {
    const original = page('folder:folder')
    const after = preserveConvertedSshBrowserPages(
      { ...owners, browserPagesByWorkspace: { browser: [original] } },
      'target'
    )
    expect(after.browser?.[0]?.browserRuntimeEnvironmentId).toBeNull()
  })

  it('keeps explicit remote placement and pages on another host unchanged', () => {
    const remote = { ...page(), browserRuntimeEnvironmentId: 'env' }
    const local = { ...page(), browserRuntimeEnvironmentId: null }
    const other = page('unknown')
    const browserPagesByWorkspace = { browser: [remote, local, other] }
    expect(preserveConvertedSshBrowserPages({ ...owners, browserPagesByWorkspace }, 'target')).toBe(
      browserPagesByWorkspace
    )
    expect(preserveConvertedSshBrowserPages({ ...owners, browserPagesByWorkspace }, 'other')).toBe(
      browserPagesByWorkspace
    )
  })

  it('preserves local URL history across document conversion without changing document ownership', () => {
    const doc = {
      ...page(),
      docLocation: {
        kind: 'workspace-doc' as const,
        worktreeId: 'worktree',
        filePath: '/notes.md'
      },
      convertedFrom: { kind: 'url' as const, url: 'https://private.invalid/' },
      convertedTo: {
        kind: 'url' as const,
        url: 'https://remote.invalid/',
        browserRuntimeEnvironmentId: 'env'
      }
    }
    const after = preserveConvertedSshBrowserPages(
      { ...owners, browserPagesByWorkspace: { browser: [doc] } },
      'target'
    )
    expect(after.browser?.[0]).toEqual({
      ...doc,
      convertedFrom: { ...doc.convertedFrom, browserRuntimeEnvironmentId: null }
    })
    expect(after.browser?.[0]?.docLocation).toBe(doc.docLocation)
  })
})

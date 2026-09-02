import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  advanceAcrossBrowserPageConversion,
  returnAcrossBrowserPageConversion
} from './browser-page-conversion-history'

const mocks = vi.hoisted(() => ({
  convertBrowserPage: vi.fn(),
  convertBrowserPageToWorkspaceDoc: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ convertBrowserPage: mocks.convertBrowserPage }) }
}))
vi.mock('@/lib/file-preview', () => ({
  convertBrowserPageToWorkspaceDoc: mocks.convertBrowserPageToWorkspaceDoc
}))

beforeEach(() => {
  vi.clearAllMocks()
})

// The one line guarding the ssh-execution-boundary concern: ownership must ride the return leg,
// or Back moves a remote tab's browsing onto this desktop.
describe('returnAcrossBrowserPageConversion', () => {
  it('passes the recorded runtime ownership through to the rebuilt web page', () => {
    returnAcrossBrowserPageConversion('page-1', {
      kind: 'url',
      url: 'https://remote.example/',
      browserRuntimeEnvironmentId: 'env-1'
    })

    expect(mocks.convertBrowserPage).toHaveBeenCalledWith(
      'page-1',
      { kind: 'web', url: 'https://remote.example/', browserRuntimeEnvironmentId: 'env-1' },
      { leg: 'history-return' }
    )
  })

  it('says inferred explicitly when the origin recorded no ownership', () => {
    returnAcrossBrowserPageConversion('page-1', { kind: 'url', url: 'https://remote.example/' })

    const target = mocks.convertBrowserPage.mock.calls[0]?.[1] as Record<string, unknown>
    // Property present with undefined — the plan's "worktree-inferred", never client-local.
    expect('browserRuntimeEnvironmentId' in target).toBe(true)
    expect(target.browserRuntimeEnvironmentId).toBeUndefined()
  })

  it('routes a workspace-doc origin through the doc door as a return leg', () => {
    const docLocation = { kind: 'workspace-doc' as const, worktreeId: 'wt-1', filePath: '/a.html' }
    returnAcrossBrowserPageConversion('page-1', { kind: 'workspace-doc', docLocation })

    expect(mocks.convertBrowserPageToWorkspaceDoc).toHaveBeenCalledWith('page-1', docLocation, {
      leg: 'history-return'
    })
    expect(mocks.convertBrowserPage).not.toHaveBeenCalled()
  })
})

describe('advanceAcrossBrowserPageConversion', () => {
  it('re-crosses to a web target with ownership intact, as an advance leg', () => {
    advanceAcrossBrowserPageConversion('page-1', {
      kind: 'url',
      url: 'https://remote.example/',
      browserRuntimeEnvironmentId: 'env-1'
    })

    expect(mocks.convertBrowserPage).toHaveBeenCalledWith(
      'page-1',
      { kind: 'web', url: 'https://remote.example/', browserRuntimeEnvironmentId: 'env-1' },
      { leg: 'history-advance' }
    )
  })

  it('re-crosses to a workspace-doc target as an advance leg', () => {
    const docLocation = { kind: 'workspace-doc' as const, worktreeId: 'wt-1', filePath: '/a.html' }
    advanceAcrossBrowserPageConversion('page-1', { kind: 'workspace-doc', docLocation })

    expect(mocks.convertBrowserPageToWorkspaceDoc).toHaveBeenCalledWith('page-1', docLocation, {
      leg: 'history-advance'
    })
    expect(mocks.convertBrowserPage).not.toHaveBeenCalled()
  })
})

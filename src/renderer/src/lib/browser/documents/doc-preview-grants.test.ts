import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectionId: null as string | null | undefined,
  environmentId: null as string | null,
  ambiguous: false,
  mintGrant: vi.fn(),
  revokeGrant: vi.fn()
}))

vi.mock('@/lib/workspace/ownership/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: () => mocks.connectionId
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => (mocks.ambiguous ? null : mocks.environmentId)
}))

import {
  buildDocPreviewGrantRequest,
  ensureDocPreviewGrant,
  releaseDocPreviewGrant
} from './doc-preview-grants'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectionId = null
  mocks.environmentId = null
  mocks.ambiguous = false
  mocks.mintGrant.mockResolvedValue({ grantId: 'grant-1', url: 'orca-preview://grant-1/a.html' })
  vi.stubGlobal('window', {
    api: { docPreview: { mintGrant: mocks.mintGrant, revokeGrant: mocks.revokeGrant } }
  })
})

describe('doc preview grant lifetime', () => {
  // Why: Share reads and keys from the handle's location, so a later host change must not move it.
  it('keeps the minted location on the handle until the grant is released', async () => {
    const minted = {
      owner: {
        kind: 'runtime' as const,
        environmentId: 'server-1',
        worktreeSelector: 'id:wt-1',
        worktreeRoot: '/srv/repo'
      },
      requestBase: '/srv/repo',
      root: '/srv/repo/docs',
      entryRelativePath: 'docs/a.html'
    }
    const movedHost = { ...minted, owner: { ...minted.owner, environmentId: 'server-2' } }

    await expect(ensureDocPreviewGrant('preview-5', minted)).resolves.toMatchObject({
      location: minted
    })
    await expect(ensureDocPreviewGrant('preview-5', movedHost)).resolves.toMatchObject({
      location: minted
    })
    expect(mocks.mintGrant).toHaveBeenCalledExactlyOnceWith({
      ...minted,
      browserPageId: 'preview-5'
    })

    releaseDocPreviewGrant('preview-5')
    await expect(ensureDocPreviewGrant('preview-5', movedHost)).resolves.toMatchObject({
      location: movedHost
    })
  })

  // Late rejection from a released tab must not evict its reopened tab’s new, otherwise unrevokable grant.
  it('leaves the entry of a later mint alone when an earlier one rejects', async () => {
    const request = {
      owner: { kind: 'ssh' as const, connectionId: 'ssh-1' },
      requestBase: '/d',
      root: '/d',
      entryRelativePath: 'a.html'
    }
    let failStaleMint: (error: Error) => void = () => {}
    mocks.mintGrant.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failStaleMint = reject
      })
    )
    mocks.mintGrant.mockResolvedValueOnce({
      grantId: 'grant-2',
      url: 'orca-preview://grant-2/a.html'
    })

    const stale = ensureDocPreviewGrant('preview-4', request)
    releaseDocPreviewGrant('preview-4')
    await ensureDocPreviewGrant('preview-4', request)
    failStaleMint(new Error('runtime offline'))
    await expect(stale).rejects.toThrow('runtime offline')

    releaseDocPreviewGrant('preview-4')
    await vi.waitFor(() => expect(mocks.revokeGrant).toHaveBeenCalledWith('grant-2'))
  })
})

describe('outside-workspace document grants', () => {
  it.each([
    ['/srv/repo', '/tmp/reports/proposal.html', '/tmp/reports'],
    ['C:/repo', 'C:/reports/proposal.html', 'C:/reports']
  ])(
    'keeps %s as the source workspace while granting only the opened document',
    (workspaceRoot, filePath, root) => {
      mocks.environmentId = 'env-1'
      const state = createTestStore().getState()
      state.getKnownWorktreeById = () =>
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: workspaceRoot })
      expect(buildDocPreviewGrantRequest(state, 'wt-1', filePath)).toEqual({
        owner: {
          kind: 'runtime',
          environmentId: 'env-1',
          worktreeSelector: 'id:wt-1',
          worktreeRoot: workspaceRoot,
          fileAccess: 'terminal-artifact'
        },
        requestBase: root,
        root,
        entryRelativePath: 'proposal.html'
      })
    }
  )
})

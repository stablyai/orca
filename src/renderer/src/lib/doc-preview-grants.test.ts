import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectionId: null as string | null | undefined,
  environmentId: null as string | null,
  mintGrant: vi.fn(),
  revokeGrant: vi.fn()
}))

vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: () => mocks.connectionId
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.environmentId
}))

import {
  buildDocPreviewGrantRequest,
  ensureDocPreviewGrant,
  releaseDocPreviewGrant
} from './doc-preview-grants'

const state = { getKnownWorktreeById: () => ({ id: 'wt-1', path: '/srv/repo' }) } as never

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectionId = null
  mocks.environmentId = null
  mocks.mintGrant.mockResolvedValue({ grantId: 'grant-1', url: 'orca-preview://grant-1/a.html' })
  vi.stubGlobal('window', {
    api: { docPreview: { mintGrant: mocks.mintGrant, revokeGrant: mocks.revokeGrant } }
  })
})

describe('buildDocPreviewGrantRequest', () => {
  // A document outside every workspace resolves and authorizes from its own directory.
  it('roots an SSH grant outside the workspace at the document directory', () => {
    mocks.connectionId = 'ssh-1'

    expect(buildDocPreviewGrantRequest(state, 'wt-1', '/home/alice/docs/report.html')).toEqual({
      owner: { kind: 'ssh', connectionId: 'ssh-1' },
      requestBase: '/home/alice/docs',
      root: '/home/alice/docs',
      entryRelativePath: 'report.html'
    })
  })

  it('resolves from the workspace but authorizes only the document directory', () => {
    mocks.connectionId = 'ssh-1'

    expect(buildDocPreviewGrantRequest(state, 'wt-1', '/srv/repo/docs/report.html')).toEqual({
      owner: { kind: 'ssh', connectionId: 'ssh-1' },
      requestBase: '/srv/repo',
      root: '/srv/repo/docs',
      entryRelativePath: 'docs/report.html'
    })
  })

  it('carries the worktree selector and root for a paired runtime grant', () => {
    mocks.environmentId = 'env-1'

    expect(buildDocPreviewGrantRequest(state, 'wt-1', '/srv/repo/docs/report.html')).toEqual({
      owner: {
        kind: 'runtime',
        environmentId: 'env-1',
        worktreeSelector: 'id:wt-1',
        worktreeRoot: '/srv/repo'
      },
      requestBase: '/srv/repo',
      root: '/srv/repo/docs',
      entryRelativePath: 'docs/report.html'
    })
  })

  // Why: files.read is worktree-scoped, so a paired document outside it has no readable root.
  it('refuses a paired document outside the workspace', () => {
    mocks.environmentId = 'env-1'

    expect(buildDocPreviewGrantRequest(state, 'wt-1', '/var/tmp/report.html')).toBeNull()
  })

  it('refuses a local workspace, which has no remote channel to read over', () => {
    expect(buildDocPreviewGrantRequest(state, 'wt-1', '/tmp/report.html')).toBeNull()
  })
})

describe('doc preview grant lifetime', () => {
  it('mints once for repeated mounts of the same preview tab', async () => {
    const request = {
      owner: { kind: 'ssh' as const, connectionId: 'ssh-1' },
      requestBase: '/d',
      root: '/d',
      entryRelativePath: 'a.html'
    }

    const [first, second] = await Promise.all([
      ensureDocPreviewGrant('preview-1', request),
      ensureDocPreviewGrant('preview-1', request)
    ])

    // Why: React StrictMode double-invokes mount effects in dev; a second mint would
    // strand the first grant and a mount-scoped revoke would kill the live webview.
    expect(mocks.mintGrant).toHaveBeenCalledOnce()
    expect(first).toBe(second)
    expect(mocks.revokeGrant).not.toHaveBeenCalled()
  })

  it('revokes on release and mints fresh afterwards', async () => {
    const request = {
      owner: { kind: 'ssh' as const, connectionId: 'ssh-1' },
      requestBase: '/d',
      root: '/d',
      entryRelativePath: 'a.html'
    }
    await ensureDocPreviewGrant('preview-2', request)

    releaseDocPreviewGrant('preview-2')
    await vi.waitFor(() => expect(mocks.revokeGrant).toHaveBeenCalledWith('grant-1'))

    await ensureDocPreviewGrant('preview-2', request)
    expect(mocks.mintGrant).toHaveBeenCalledTimes(2)
  })

  it('ignores a release for a tab that never minted a grant', () => {
    releaseDocPreviewGrant('never-opened')

    expect(mocks.revokeGrant).not.toHaveBeenCalled()
  })

  // Why: a mint that rejects after the tab was released and reopened must not evict the entry the
  // reopen created, or that grant can never be revoked from the tab that owns it.
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

  it('does not cache a failed mint', async () => {
    mocks.mintGrant.mockRejectedValueOnce(new Error('runtime offline'))
    const request = {
      owner: { kind: 'ssh' as const, connectionId: 'ssh-1' },
      requestBase: '/d',
      root: '/d',
      entryRelativePath: 'a.html'
    }

    await expect(ensureDocPreviewGrant('preview-3', request)).rejects.toThrow('runtime offline')
    await expect(ensureDocPreviewGrant('preview-3', request)).resolves.toMatchObject({
      grantId: 'grant-1'
    })
  })
})

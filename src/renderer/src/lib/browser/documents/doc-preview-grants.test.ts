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

import { ensureDocPreviewGrant, releaseDocPreviewGrant } from './doc-preview-grants'

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

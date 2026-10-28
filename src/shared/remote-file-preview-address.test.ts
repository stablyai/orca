import { describe, expect, it } from 'vitest'
import { parseRemoteFilePreviewAddress } from './remote-file-preview-address'

const address = {
  environmentId: 'env-1',
  worktree: 'id:wt-1',
  relativePath: 'out/clip.mp4',
  expectedEnvironmentPairingRevision: 4
}

describe('parseRemoteFilePreviewAddress', () => {
  it('keeps only the address fields', () => {
    expect(parseRemoteFilePreviewAddress({ ...address, extra: 'ignored' })).toEqual(address)
    const { expectedEnvironmentPairingRevision: _revision, ...unpinned } = address
    expect(parseRemoteFilePreviewAddress(unpinned)).toEqual(unpinned)
  })

  it.each([
    { relativePath: '/etc/a.mp4' },
    { relativePath: 'C:\\a.mp4' },
    { relativePath: 'a\0.mp4' },
    { expectedEnvironmentPairingRevision: 1.5 },
    { expectedEnvironmentPairingRevision: '4' },
    { worktree: '' }
  ])('refuses %o', (override) => {
    expect(parseRemoteFilePreviewAddress({ ...address, ...override })).toBeNull()
  })
})

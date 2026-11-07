import { describe, expect, it } from 'vitest'
import { parseRemoteFilePreviewAddress } from './remote-file-preview-address'

const address = {
  environmentId: 'env-1',
  worktree: 'id:wt-1',
  relativePath: 'out/clip.mp4',
  expectedEnvironmentPairingRevision: 4
}

describe('parseRemoteFilePreviewAddress', () => {
  it.each([
    { relativePath: '/etc/a.mp4' },
    { relativePath: 'C:\\a.mp4' },
    { relativePath: 'a\0.mp4' },
    { expectedEnvironmentPairingRevision: 1.5 },
    { expectedEnvironmentPairingRevision: '4' },
    { worktree: '' },
    { grantId: 'g-1', absolutePath: '/tmp/clip.mp4' }
  ])('refuses %o', (override) => {
    expect(parseRemoteFilePreviewAddress({ ...address, ...override })).toBeNull()
  })

  it('accepts a granted file only by its absolute host path', () => {
    const { relativePath: _relativePath, ...base } = address
    const granted = { ...base, grantId: 'g-1', absolutePath: '/tmp/clip.mp4' }
    expect(parseRemoteFilePreviewAddress(granted)).toEqual(granted)
    expect(parseRemoteFilePreviewAddress({ ...granted, absolutePath: 'tmp/clip.mp4' })).toBeNull()
  })
})

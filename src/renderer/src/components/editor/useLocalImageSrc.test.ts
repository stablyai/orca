import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocalImageCacheKey, loadLocalImageSrc } from './useLocalImageSrc'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLocalImageCacheKey', () => {
  it('scopes local markdown image cache entries by runtime owner', () => {
    const localKey = getLocalImageCacheKey('/repo/docs/logo.png', null, {
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
    const remoteKey = getLocalImageCacheKey('/repo/docs/logo.png', null, {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
    const otherRemoteKey = getLocalImageCacheKey('/repo/docs/logo.png', null, {
      settings: { activeRuntimeEnvironmentId: 'env-2' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })

    expect(localKey).not.toBe(remoteKey)
    expect(remoteKey).not.toBe(otherRemoteKey)
  })

  it('does not fall back to raw local src when IPC returns non-binary content', async () => {
    const readFile = vi.fn().mockResolvedValue({
      isBinary: false,
      content: '<svg></svg>',
      mimeType: 'image/svg+xml'
    })
    vi.stubGlobal('window', {
      api: {
        fs: { readFile }
      }
    })

    await expect(loadLocalImageSrc('diagram.svg', '/repo/docs/readme.md')).resolves.toBeNull()
    expect(readFile).toHaveBeenCalledWith({
      filePath: '/repo/docs/diagram.svg',
      connectionId: undefined
    })
  })

  it('does not fall back to raw local src when IPC rejects the read', async () => {
    vi.stubGlobal('window', {
      api: {
        fs: { readFile: vi.fn().mockRejectedValue(new Error('denied')) }
      }
    })

    await expect(
      loadLocalImageSrc('file:///repo/docs/diagram.png', '/repo/docs/readme.md')
    ).resolves.toBeNull()
  })
})

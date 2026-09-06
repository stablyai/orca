// @vitest-environment happy-dom

import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLocalImageCacheKey,
  invalidateLocalImageSrcCacheForTests,
  loadLocalImageSrc,
  releaseLocalImageSrc,
  resetLocalImageSrcStateForTests,
  useLocalImageSrc
} from './useLocalImageSrc'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  getLocalImageCacheKeyVersion,
  pinLocalImageCache
} from './local-image-src-cache'

type PreviewResult = {
  content: string
  isBinary: boolean
  mimeType?: string
}

function deferred<T>(): {
  promise: Promise<T>
  reject: (error: unknown) => void
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function binaryPreview(content = 'AA=='): PreviewResult {
  return { content, isBinary: true, mimeType: 'image/png' }
}

function setReadFile(readFile: ReturnType<typeof vi.fn>): void {
  globalThis.window.api = {
    fs: { readFile }
  } as unknown as Window['api']
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function HookProbe({
  filePath,
  onRender,
  src
}: {
  filePath: string
  onRender: (displaySrc: string | undefined) => void
  src: string
}): null {
  onRender(useLocalImageSrc(src, filePath))
  return null
}

function HookList({ count }: { count: number }): React.JSX.Element {
  return createElement(
    Fragment,
    null,
    Array.from({ length: count }, (_value, index) =>
      createElement(HookProbe, {
        key: index,
        filePath: `/repo/image-${index}.png`,
        onRender: () => {},
        src: `/repo/image-${index}.png`
      })
    )
  )
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  vi.spyOn(URL, 'createObjectURL').mockReset()
  vi.spyOn(URL, 'revokeObjectURL').mockReset()
})

afterEach(() => {
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
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
})

describe('loadLocalImageSrc', () => {
  it('shares one pending read and one blob URL for duplicate local image loads', async () => {
    const read = deferred<PreviewResult>()
    const readFile = vi.fn().mockReturnValue(read.promise)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-image')
    setReadFile(readFile)

    const first = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    const second = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')

    expect(readFile).toHaveBeenCalledTimes(1)
    read.resolve(binaryPreview())

    await expect(Promise.all([first, second])).resolves.toEqual([
      'blob:local-image',
      'blob:local-image'
    ])
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('lets a mounted preview adopt an in-flight prewarm read', async () => {
    const read = deferred<PreviewResult>()
    const readFile = vi.fn().mockReturnValue(read.promise)
    const renders: (string | undefined)[] = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:prewarmed')
    setReadFile(readFile)

    const prewarm = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(HookProbe, {
          filePath: '/repo/docs/readme.md',
          onRender: (displaySrc) => renders.push(displaySrc),
          src: 'diagram.png'
        })
      )
    })
    expect(readFile).toHaveBeenCalledTimes(1)

    await act(async () => {
      read.resolve(binaryPreview())
      await flushPromises()
    })

    await expect(prewarm).resolves.toBe('blob:prewarmed')
    expect(renders.at(-1)).toBe('blob:prewarmed')
    root.unmount()
  })

  it('does not revoke blob URLs still used by mounted previews during eviction', async () => {
    const readFile = vi.fn().mockResolvedValue(binaryPreview())
    let nextUrl = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++nextUrl}`)
    setReadFile(readFile)

    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(HookList, { count: 101 }))
      await flushPromises()
    })

    expect(readFile).toHaveBeenCalledTimes(101)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:image-1')
    root.unmount()
  })

  it('clears failed in-flight reads so a later retry can succeed', async () => {
    const readFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(binaryPreview())
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retry')
    setReadFile(readFile)

    await expect(loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')).resolves.toBeNull()
    await expect(loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')).resolves.toBe(
      'blob:retry'
    )
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it('does not fall back to raw local src when IPC returns non-binary content', async () => {
    const readFile = vi.fn().mockResolvedValue({
      isBinary: false,
      content: '<svg></svg>',
      mimeType: 'image/svg+xml'
    })
    setReadFile(readFile)

    await expect(loadLocalImageSrc('diagram.svg', '/repo/docs/readme.md')).resolves.toBeNull()
    expect(readFile).toHaveBeenCalledWith({
      filePath: '/repo/docs/diagram.svg',
      connectionId: undefined
    })
  })

  it('does not fall back to raw local src when IPC rejects the read', async () => {
    setReadFile(vi.fn().mockRejectedValue(new Error('denied')))

    await expect(
      loadLocalImageSrc('file:///repo/docs/diagram.png', '/repo/docs/readme.md')
    ).resolves.toBeNull()
  })

  it('suppresses a stale pending completion after cache invalidation', async () => {
    const firstRead = deferred<PreviewResult>()
    const readFile = vi
      .fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(binaryPreview())
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fresh')
    setReadFile(readFile)

    const staleLoad = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    invalidateLocalImageSrcCacheForTests()
    firstRead.resolve(binaryPreview())

    await expect(staleLoad).resolves.toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    await expect(loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')).resolves.toBe(
      'blob:fresh'
    )
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it('does not let an older invalidated read overwrite a newer successful read', async () => {
    const firstRead = deferred<PreviewResult>()
    const secondRead = deferred<PreviewResult>()
    const readFile = vi
      .fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:newer')
    setReadFile(readFile)

    const staleLoad = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    invalidateLocalImageSrcCacheForTests()
    const newerLoad = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')

    secondRead.resolve(binaryPreview('AQ=='))
    await expect(newerLoad).resolves.toBe('blob:newer')
    firstRead.resolve(binaryPreview('Ag=='))
    await expect(staleLoad).resolves.toBeNull()
    await expect(loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')).resolves.toBe(
      'blob:newer'
    )
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:newer')
  })

  it('does not retain a read that resolves after its preview lease is released', async () => {
    const read = deferred<PreviewResult>()
    const readFile = vi.fn().mockReturnValue(read.promise)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:released')
    setReadFile(readFile)

    const pending = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    releaseLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    read.resolve(binaryPreview())

    await expect(pending).resolves.toBeNull()
    expect(blobUrlCache.size).toBe(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:released')
  })

  it('starts a fresh read when a released lease becomes visible again', async () => {
    const firstRead = deferred<PreviewResult>()
    const secondRead = deferred<PreviewResult>()
    const readFile = vi
      .fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:fresh')
      .mockReturnValueOnce('blob:stale')
    setReadFile(readFile)

    const stale = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    releaseLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    const fresh = loadLocalImageSrc('diagram.png', '/repo/docs/readme.md')
    expect(readFile).toHaveBeenCalledTimes(2)

    secondRead.resolve(binaryPreview('AQ=='))
    await expect(fresh).resolves.toBe('blob:fresh')
    firstRead.resolve(binaryPreview())
    await expect(stale).resolves.toBeNull()
    expect(blobUrlCache.size).toBe(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stale')
  })

  it('cleans version metadata for released unique paths', () => {
    for (let index = 0; index < 500; index += 1) {
      const path = `/repo/docs/image-${index}.png`
      releaseLocalImageSrc(path, '/repo/docs/readme.md')
      expect(getLocalImageCacheKeyVersion(getLocalImageCacheKey(path, undefined, undefined))).toBe(
        0
      )
    }
  })

  it('fails closed when pinned previews already consume the entry or byte budget', () => {
    for (let index = 0; index < 100; index += 1) {
      const key = `pinned-${index}`
      pinLocalImageCache(key)
      expect(cacheLocalImageBlob(key, `blob:${index}`, 1)).toBe(true)
    }

    expect(cacheLocalImageBlob('pinned-overflow', 'blob:overflow', 1)).toBe(false)
    expect(blobUrlCache.size).toBe(100)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:overflow')

    expect(
      cacheLocalImageBlob('large-overflow', 'blob:large-overflow', 128 * 1024 * 1024 + 1)
    ).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:large-overflow')
  })

  it('does not exceed the decoded-byte budget when all retained entries are pinned', () => {
    const retainedBytes = 80 * 1024 * 1024
    pinLocalImageCache('large-pinned-1')
    pinLocalImageCache('large-pinned-2')
    expect(cacheLocalImageBlob('large-pinned-1', 'blob:large-1', retainedBytes)).toBe(true)
    expect(cacheLocalImageBlob('large-pinned-2', 'blob:large-2', retainedBytes)).toBe(false)

    expect(blobUrlCache.size).toBe(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:large-2')
  })

  it('keeps runtime owners in separate image cache entries', async () => {
    const readFile = vi.fn().mockResolvedValue(binaryPreview())
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:runtime-one')
      .mockReturnValueOnce('blob:runtime-two')
    setReadFile(readFile)

    await expect(
      loadLocalImageSrc('diagram.png', '/repo/docs/readme.md', null, {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1'
      })
    ).resolves.toBe('blob:runtime-one')
    await expect(
      loadLocalImageSrc('diagram.png', '/repo/docs/readme.md', null, {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-2',
        worktreePath: '/repo',
        connectionId: 'ssh-2'
      })
    ).resolves.toBe('blob:runtime-two')
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it('does not load an external SSH image through a replacement target', async () => {
    const readFile = vi.fn().mockResolvedValue(binaryPreview())
    setReadFile(readFile)

    await expect(
      loadLocalImageSrc('diagram.png', '/tmp/readme.md', null, {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-2',
        expectedExternalSshTargetId: 'ssh-1'
      })
    ).resolves.toBeNull()

    expect(readFile).not.toHaveBeenCalled()
  })

  it('does not update mounted hook state after unmount', async () => {
    const read = deferred<PreviewResult>()
    const readFile = vi.fn().mockReturnValue(read.promise)
    const renders: (string | undefined)[] = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unmounted')
    setReadFile(readFile)

    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(HookProbe, {
          filePath: '/repo/docs/readme.md',
          onRender: (displaySrc) => renders.push(displaySrc),
          src: 'diagram.png'
        })
      )
    })
    await act(async () => {
      root.unmount()
    })

    read.resolve(binaryPreview())
    await act(async () => {
      await flushPromises()
    })

    expect(renders).toEqual([undefined])
  })
})

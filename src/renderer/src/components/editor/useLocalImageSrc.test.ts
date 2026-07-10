// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLocalImageCacheKey,
  invalidateLocalImageSrcCacheForTests,
  loadLocalImageSrc,
  resetLocalImageSrcStateForTests,
  useLocalImageSrc
} from './useLocalImageSrc'

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

// @vitest-environment happy-dom

import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLocalImageSrc, useLocalImageSrc } from './useLocalImageSrc'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  invalidateLocalImageCache as invalidateLocalImageSrcCacheForTests,
  resetLocalImageCacheState as resetLocalImageSrcStateForTests
} from './local-image-src-cache'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { pinLocalImageCacheKey as pinLocalImageCache } from './local-image-cache-pinning'
import {
  holdBrowserAttachmentFiles,
  readBrowserAttachmentFile,
  releaseBrowserAttachmentFiles
} from '@/lib/browser-attachment-files'

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

describe('loadLocalImageSrc', () => {
  it('previews a staged browser image before a workspace exists without consuming its upload file', async () => {
    const readFile = vi.fn(() => {
      throw new Error('Runtime files are unavailable before workspace creation')
    })
    const file = new File(['image bytes'], 'screenshot.png', { type: 'image/png' })
    const [token] = holdBrowserAttachmentFiles([file])
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:staged-image')
    setReadFile(readFile)

    try {
      await expect(loadLocalImageSrc(token, '', undefined, null)).resolves.toBe('blob:staged-image')
      expect(readBrowserAttachmentFile(token)).toBe(file)
    } finally {
      releaseBrowserAttachmentFiles([token])
    }
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

  it('does not exceed the decoded-byte budget when all retained entries are pinned', () => {
    const retainedBytes = 80 * 1024 * 1024
    pinLocalImageCache('large-pinned-1')
    pinLocalImageCache('large-pinned-2')
    expect(cacheLocalImageBlob('large-pinned-1', 'blob:large-1', retainedBytes)).toBe(true)
    expect(cacheLocalImageBlob('large-pinned-2', 'blob:large-2', retainedBytes)).toBe(false)

    expect(blobUrlCache.size).toBe(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:large-2')
  })
})

describe('useLocalImageSrc runtime owner', () => {
  const imageSrc = 'diagram.png'
  const documentPath = '/repo/docs/readme.md'

  function sshOwner(overrides: Partial<RuntimeFileOperationArgs> = {}): RuntimeFileOperationArgs {
    return {
      target: { kind: 'local' as const },
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 1,
      ...overrides
    }
  }

  function OwnerProbe({
    onRender,
    runtimeContext
  }: {
    onRender: (displaySrc: string | undefined) => void
    runtimeContext: RuntimeFileOperationArgs
  }): null {
    onRender(useLocalImageSrc(imageSrc, documentPath, null, runtimeContext))
    return null
  }

  function renderOwner(
    root: Root,
    runtimeContext: RuntimeFileOperationArgs,
    onRender: (displaySrc: string | undefined) => void
  ): void {
    root.render(createElement(OwnerProbe, { onRender, runtimeContext }))
  }

  it.each([
    ['an SSH reconnect', { expectedSshConnectionGeneration: 2 }],
    ['another worktree', { worktreeId: 'wt-2', worktreePath: '/repo-2' }]
  ])('re-reads the image after %s changes its owner', async (_label, change) => {
    const readFile = vi.fn().mockResolvedValue(binaryPreview())
    let nextUrl = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:owner-${++nextUrl}`)
    setReadFile(readFile)
    const renders: (string | undefined)[] = []
    const onRender = (displaySrc: string | undefined): void => {
      renders.push(displaySrc)
    }

    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      renderOwner(root, sshOwner(), onRender)
      await flushPromises()
    })
    expect(renders.at(-1)).toBe('blob:owner-1')

    await act(async () => {
      renderOwner(root, sshOwner(change), onRender)
      await flushPromises()
    })

    expect(readFile).toHaveBeenCalledTimes(2)
    expect(renders.at(-1)).toBe('blob:owner-2')
    root.unmount()
  })
})

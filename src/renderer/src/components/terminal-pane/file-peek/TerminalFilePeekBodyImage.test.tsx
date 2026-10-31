// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateLocalImageSrcCacheForTests,
  releaseLocalImageSrcByKey,
  resetLocalImageSrcStateForTests
} from '@/components/editor/useLocalImageSrc'
import { blobUrlCache } from '@/components/editor/local-image-src-cache'
import { toWindowsWslPath } from '../../../../../shared/wsl-paths'
import type { FileLinkTarget } from '../terminal-file-link-target'
import { TerminalLinkFilePreview } from './TerminalLinkFilePreview'

const TARGET: FileLinkTarget = {
  absolutePath: '/repo/logo.png',
  line: null,
  column: null,
  fileContext: {
    target: { kind: 'local' },
    worktreeId: 'folder:repo',
    worktreePath: '/repo',
    sourceHostResolved: true
  },
  isRemoteRuntimePath: false,
  cacheKey: 'image-peek',
  isKnownWorktreeRoot: false
}
const stat = vi.fn()
const readFile = vi.fn()
const IMAGE_BYTES = { isBinary: true, content: 'AA==', mimeType: 'image/png' }
const IMAGE_PATHS = [
  { name: 'POSIX', path: '/repo/logo.png', readPath: '/repo/logo.png', root: '/repo' },
  {
    name: 'WSL UNC',
    path: toWindowsWslPath('/home/dev/repo/logo.png', 'Ubuntu'),
    readPath: '//wsl.localhost/Ubuntu/home/dev/repo/logo.png',
    root: toWindowsWslPath('/home/dev/repo', 'Ubuntu')
  },
  {
    name: 'WSL Windows drive',
    path: toWindowsWslPath('/mnt/c/repo/logo.png', 'Ubuntu'),
    readPath: 'C:/repo/logo.png',
    root: toWindowsWslPath('/mnt/c/repo', 'Ubuntu')
  }
]

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  stat.mockReset().mockResolvedValue({ size: 2048, isDirectory: false, mtime: 1 })
  readFile.mockReset()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:peek-image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('api', { fs: { stat, readFile } })
})

afterEach(() => {
  cleanup()
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TerminalFilePeekBodyImage', () => {
  it.each(IMAGE_PATHS)(
    'shares one read and leased cache entry for a $name path',
    async (imagePath) => {
      let resolveRead!: (value: typeof IMAGE_BYTES) => void
      readFile.mockReturnValue(new Promise((resolve) => (resolveRead = resolve)))
      const { unmount } = render(
        <TerminalLinkFilePreview
          target={{
            ...TARGET,
            absolutePath: imagePath.path,
            fileContext: { ...TARGET.fileContext, worktreePath: imagePath.root }
          }}
        />
      )
      await screen.findByText('2.00 KB')

      expect(readFile).toHaveBeenCalledTimes(1)
      expect(readFile).toHaveBeenCalledWith({
        filePath: imagePath.readPath,
        connectionId: undefined
      })
      await act(async () => resolveRead(IMAGE_BYTES))
      const image = await screen.findByRole('img', { name: 'logo.png' })

      expect(image.getAttribute('src')).toBe('blob:peek-image')
      expect(blobUrlCache.size).toBe(1)
      const [key] = blobUrlCache.keys()
      releaseLocalImageSrcByKey(key)
      expect(blobUrlCache.size).toBe(1)
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()

      unmount()
      releaseLocalImageSrcByKey(key)
      expect(blobUrlCache.size).toBe(0)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:peek-image')
    }
  )

  it('shows the cached owner-routed image and retains the image decode failure notice', async () => {
    readFile.mockResolvedValue(IMAGE_BYTES)
    render(<TerminalLinkFilePreview target={TARGET} />)
    const image = await screen.findByRole('img', { name: 'logo.png' })

    expect(image.getAttribute('src')).toBe('blob:peek-image')
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    fireEvent.error(image)

    expect(screen.getByText("This image can't be shown.")).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows an unreadable notice when refocus revalidation fails after a successful image read', async () => {
    readFile.mockResolvedValueOnce(IMAGE_BYTES).mockRejectedValueOnce(new Error('Deleted'))
    const { container } = render(<TerminalLinkFilePreview target={TARGET} />)
    await screen.findByRole('img', { name: 'logo.png' })

    await act(async () => invalidateLocalImageSrcCacheForTests())

    expect(await screen.findByText("This file can't be read.")).toBeTruthy()
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.motion-safe\\:animate-pulse')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('ignores an invalidated read that finishes after its replacement has failed', async () => {
    let resolveFirst!: (value: typeof IMAGE_BYTES) => void
    readFile
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockRejectedValueOnce(new Error('Replacement denied'))
    const { container } = render(<TerminalLinkFilePreview target={TARGET} />)
    await screen.findByText('2.00 KB')

    await act(async () => invalidateLocalImageSrcCacheForTests())
    expect(await screen.findByText("This file can't be read.")).toBeTruthy()
    await act(async () => resolveFirst(IMAGE_BYTES))

    expect(screen.getByText("This file can't be read.")).toBeTruthy()
    expect(container.querySelector('.motion-safe\\:animate-pulse')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it.each(
    IMAGE_PATHS.flatMap((imagePath) =>
      (['rejected', 'null'] as const).map((failure) => ({ ...imagePath, failure }))
    )
  )(
    'shows the unreadable notice for a $name path after a $failure byte read and successful stat',
    async (imagePath) => {
      let settle!: () => void
      readFile.mockReturnValue(
        new Promise((resolve, reject) => {
          settle = () =>
            imagePath.failure === 'rejected' ? reject(new Error('Read denied')) : resolve(null)
        })
      )
      const { container } = render(
        <TerminalLinkFilePreview
          target={{
            ...TARGET,
            absolutePath: imagePath.path,
            fileContext: { ...TARGET.fileContext, worktreePath: imagePath.root }
          }}
        />
      )
      await screen.findByText('2.00 KB')
      expect(stat).toHaveBeenCalledTimes(1)
      expect(readFile).toHaveBeenCalledTimes(1)
      expect(readFile).toHaveBeenCalledWith({
        filePath: imagePath.readPath,
        connectionId: undefined
      })
      expect(container.querySelector('.animate-pulse, .motion-safe\\:animate-pulse')).toBeTruthy()

      await act(async () => settle())

      expect(await screen.findByText("This file can't be read.")).toBeTruthy()
      expect(container.querySelector('.animate-pulse, .motion-safe\\:animate-pulse')).toBeNull()
      expect(container.querySelector('img')).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
      expect(blobUrlCache.size).toBe(0)
    }
  )
})

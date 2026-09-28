import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteDownloadProgress } from '../../../../shared/remote-download-progress'
import {
  formatRemoteDownloadDetail,
  getRemoteDownloadPercent,
  REMOTE_DOWNLOAD_TOAST_DELAY_MS,
  runRemoteDownloadWithProgress
} from './remote-download-progress-toast'

const { toastMock } = vi.hoisted(() => ({
  toastMock: { loading: vi.fn(), message: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('sonner', () => ({ toast: toastMock }))

type ProgressListener = (progress: RemoteDownloadProgress) => void

function progress(overrides: Partial<RemoteDownloadProgress> = {}): RemoteDownloadProgress {
  return {
    downloadId: 'd1',
    transferredBytes: 0,
    totalBytes: null,
    completedFiles: 0,
    ...overrides
  }
}

describe('runRemoteDownloadWithProgress', () => {
  let listener: ProgressListener | undefined
  const cancelDownload = vi.fn()
  const unsubscribe = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    toastMock.loading.mockReset()
    toastMock.message.mockReset()
    toastMock.dismiss.mockReset()
    cancelDownload.mockReset().mockResolvedValue({ ok: true, canceled: true })
    unsubscribe.mockReset()
    listener = undefined
    vi.stubGlobal('window', {
      api: {
        fs: {
          cancelDownload,
          onDownloadProgress: (callback: ProgressListener) => {
            listener = callback
            return unsubscribe
          }
        }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows nothing for a download that finishes before the toast delay', async () => {
    const result = await runRemoteDownloadWithProgress(
      { name: 'a.txt', isDirectory: false },
      async (transfer) => {
        listener?.(progress({ downloadId: transfer.downloadId, transferredBytes: 5 }))
        return { canceled: false, destinationPath: '/downloads/a.txt' }
      }
    )
    vi.advanceTimersByTime(REMOTE_DOWNLOAD_TOAST_DELAY_MS)

    expect(result).toEqual({ canceled: false, destinationPath: '/downloads/a.txt' })
    expect(toastMock.loading).not.toHaveBeenCalled()
    expect(toastMock.dismiss).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('shows progress for a slow download, ignores other downloads, and clears it on success', async () => {
    let finish: (() => void) | undefined
    const download = runRemoteDownloadWithProgress(
      { name: 'a.bin', isDirectory: false },
      (transfer) => {
        listener?.(progress({ downloadId: 'someone-else', transferredBytes: 1 }))
        listener?.(progress({ downloadId: transfer.downloadId, transferredBytes: 5 }))
        return new Promise((resolve) => {
          finish = () => resolve({ canceled: false, destinationPath: '/downloads/a.bin' })
        })
      }
    )
    expect(toastMock.loading).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REMOTE_DOWNLOAD_TOAST_DELAY_MS)

    expect(toastMock.loading).toHaveBeenCalledTimes(1)
    const [title, options] = toastMock.loading.mock.calls[0]
    expect(title).toBe("Downloading 'a.bin'")
    expect(options).toEqual(
      expect.objectContaining({
        duration: Infinity,
        action: expect.objectContaining({ label: 'Cancel' })
      })
    )

    finish?.()
    await download
    expect(toastMock.dismiss).toHaveBeenCalledWith(options.id)
  })

  it('cancels through the toast action and resolves as a canceled download', async () => {
    let signal: AbortSignal | undefined
    const download = runRemoteDownloadWithProgress(
      { name: 'src', isDirectory: true },
      (transfer) => {
        signal = transfer.signal
        listener?.(progress({ downloadId: transfer.downloadId }))
        return new Promise((_resolve, reject) => {
          transfer.signal.addEventListener('abort', () => reject(transfer.signal.reason))
        })
      }
    )
    vi.advanceTimersByTime(REMOTE_DOWNLOAD_TOAST_DELAY_MS)
    const options = toastMock.loading.mock.calls[0][1]
    const preventDefault = vi.fn()
    options.action.onClick({ preventDefault })

    await expect(download).resolves.toEqual({ canceled: true })
    expect(preventDefault).toHaveBeenCalled()
    expect(signal?.aborted).toBe(true)
    expect(cancelDownload).toHaveBeenCalledWith({ downloadId: expect.any(String) })
    expect(toastMock.message).toHaveBeenCalledWith(
      'Download canceled',
      expect.objectContaining({ id: options.id })
    )
    expect(toastMock.dismiss).not.toHaveBeenCalled()
  })

  it('rethrows failures that were not user cancels', async () => {
    await expect(
      runRemoteDownloadWithProgress({ name: 'a', isDirectory: false }, async () => {
        throw new Error('Remote connection dropped')
      })
    ).rejects.toThrow('Remote connection dropped')
    expect(toastMock.message).not.toHaveBeenCalled()
  })

  it('feeds local progress trackers into the same toast', async () => {
    const download = runRemoteDownloadWithProgress(
      { name: 'a.bin', isDirectory: false },
      (transfer) => {
        transfer.trackLocalProgress(10).addBytes(4)
        return new Promise(() => {})
      }
    )
    vi.advanceTimersByTime(REMOTE_DOWNLOAD_TOAST_DELAY_MS)
    expect(toastMock.loading).toHaveBeenCalledTimes(1)
    void download
  })
})

describe('remote download progress copy', () => {
  it('formats file and folder details', () => {
    expect(
      formatRemoteDownloadDetail(progress({ transferredBytes: 512, totalBytes: 2048 }), false)
    ).toBe('512 B / 2.0 KB')
    expect(
      formatRemoteDownloadDetail(progress({ transferredBytes: 512, completedFiles: 1 }), true)
    ).toBe('1 file · 512 B')
    expect(
      formatRemoteDownloadDetail(progress({ transferredBytes: 512, completedFiles: 3 }), true)
    ).toBe('3 files · 512 B')
  })

  it('computes a percent only when the total is known', () => {
    expect(getRemoteDownloadPercent(progress({ transferredBytes: 5, totalBytes: 10 }))).toBe(50)
    expect(getRemoteDownloadPercent(progress({ transferredBytes: 5, totalBytes: 4 }))).toBe(100)
    expect(getRemoteDownloadPercent(progress({ transferredBytes: 5, totalBytes: null }))).toBeNull()
    expect(getRemoteDownloadPercent(progress({ transferredBytes: 0, totalBytes: 0 }))).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteDownloadProgress } from '../../../../shared/remote-download-progress'
import { runRemoteDownloadWithProgress } from './download-progress-panel'

const { panel, openPanel } = vi.hoisted(() => {
  const panel = {
    sessionId: 's',
    updateRow: vi.fn(),
    markCancelling: vi.fn(),
    settle: vi.fn(),
    close: vi.fn()
  }
  return {
    panel,
    openPanel: vi.fn(
      (_direction: string, _rows: unknown[], _onCancel: (transferId: string) => void) => panel
    )
  }
})

vi.mock('./open-transfer-progress-panel', () => ({ openTransferProgressPanel: openPanel }))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'd1' }))

type Listener = (progress: RemoteDownloadProgress) => void

describe('runRemoteDownloadWithProgress', () => {
  let listener: Listener | undefined
  const cancelDownload = vi.fn()
  const unsubscribe = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    listener = undefined
    cancelDownload.mockResolvedValue({ ok: true, canceled: true })
    vi.stubGlobal('window', {
      api: {
        fs: {
          cancelDownload,
          onDownloadProgress: (callback: Listener) => {
            listener = callback
            return unsubscribe
          }
        }
      }
    })
  })

  const item = { name: 'a.bin', isDirectory: false }

  it('opens no panel when the save dialog was dismissed', async () => {
    await expect(
      runRemoteDownloadWithProgress(item, async () => ({ canceled: true }))
    ).resolves.toEqual({ canceled: true })
    expect(openPanel).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('opens the panel on the first progress event, ignores other downloads, and closes on success', async () => {
    const result = await runRemoteDownloadWithProgress(item, async () => {
      listener?.({ downloadId: 'other', transferredBytes: 1, totalBytes: 1, completedFiles: 0 })
      listener?.({ downloadId: 'd1', transferredBytes: 4, totalBytes: 10, completedFiles: 0 })
      return { canceled: false, destinationPath: '/downloads/a.bin' }
    })

    expect(result).toEqual({ canceled: false, destinationPath: '/downloads/a.bin' })
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(openPanel).toHaveBeenCalledWith(
      'download',
      [expect.objectContaining({ transferId: 'd1', name: 'a.bin', status: 'active' })],
      expect.any(Function)
    )
    expect(panel.updateRow).toHaveBeenCalledWith('d1', { sentBytes: 4, totalBytes: 10 })
    expect(panel.close).toHaveBeenCalledTimes(1)
  })

  it('cancels through the panel and resolves as a canceled download', async () => {
    const download = runRemoteDownloadWithProgress(item, (transfer) => {
      listener?.({ downloadId: 'd1', transferredBytes: 1, totalBytes: 10, completedFiles: 0 })
      return new Promise((_resolve, reject) => {
        transfer.signal.addEventListener('abort', () => reject(transfer.signal.reason))
      })
    })
    const cancel = openPanel.mock.calls[0][2]
    cancel('d1')

    await expect(download).resolves.toEqual({ canceled: true })
    expect(cancelDownload).toHaveBeenCalledWith({ downloadId: 'd1' })
    expect(panel.markCancelling).toHaveBeenCalledWith('d1')
    expect(panel.updateRow).toHaveBeenLastCalledWith('d1', { status: 'cancelled' })
    expect(panel.settle).toHaveBeenCalledTimes(1)
    expect(panel.close).not.toHaveBeenCalled()
  })

  it('closes the panel and rethrows a real failure', async () => {
    await expect(
      runRemoteDownloadWithProgress(item, async () => {
        listener?.({ downloadId: 'd1', transferredBytes: 1, totalBytes: 10, completedFiles: 0 })
        throw new Error('Remote connection dropped')
      })
    ).rejects.toThrow('Remote connection dropped')
    expect(panel.close).toHaveBeenCalledTimes(1)
    expect(panel.settle).not.toHaveBeenCalled()
  })

  it('feeds a local tracker into the same row', async () => {
    await runRemoteDownloadWithProgress(item, async (transfer) => {
      const tracker = transfer.trackLocalProgress(8)
      tracker.addBytes(3)
      return { canceled: false, destinationPath: '/downloads/a.bin' }
    })
    expect(panel.updateRow).toHaveBeenCalledWith('d1', { sentBytes: 3, totalBytes: 8 })
  })

  it('never claims Cancelled when the download finished before the cancel landed', async () => {
    const result = await runRemoteDownloadWithProgress(item, async () => {
      listener?.({ downloadId: 'd1', transferredBytes: 10, totalBytes: 10, completedFiles: 0 })
      // Why: the click arrives after promote; the result, not the click, decides the row.
      openPanel.mock.calls[0][2]('d1')
      return { canceled: false, destinationPath: '/downloads/a.bin' }
    })

    expect(result).toEqual({ canceled: false, destinationPath: '/downloads/a.bin' })
    expect(panel.updateRow).not.toHaveBeenCalledWith('d1', { status: 'cancelled' })
    expect(panel.close).toHaveBeenCalledTimes(1)
  })
})

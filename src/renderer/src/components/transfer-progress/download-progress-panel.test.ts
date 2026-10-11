import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('runRemoteDownloadWithProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens no panel when the save dialog was dismissed', async () => {
    await expect(
      runRemoteDownloadWithProgress('a.bin', async () => ({ canceled: true }))
    ).resolves.toEqual({ canceled: true })
    expect(openPanel).not.toHaveBeenCalled()
  })

  it('opens the panel on the first progress report and closes on success', async () => {
    const result = await runRemoteDownloadWithProgress('a.bin', async (transfer) => {
      const tracker = transfer.trackProgress(10)
      tracker.addBytes(4)
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

  it('aborts the transfer on cancel and resolves as a canceled download', async () => {
    let signal: AbortSignal | undefined
    const download = runRemoteDownloadWithProgress('a.bin', (transfer) => {
      signal = transfer.signal
      transfer.trackProgress(10).flush()
      return new Promise((_resolve, reject) => {
        transfer.signal.addEventListener('abort', () => reject(transfer.signal.reason))
      })
    })
    const cancel = openPanel.mock.calls[0][2]
    cancel('d1')

    await expect(download).resolves.toEqual({ canceled: true })
    expect(signal?.aborted).toBe(true)
    expect(panel.markCancelling).toHaveBeenCalledWith('d1')
    expect(panel.updateRow).toHaveBeenLastCalledWith('d1', { status: 'cancelled' })
    expect(panel.settle).toHaveBeenCalledTimes(1)
    expect(panel.close).not.toHaveBeenCalled()
  })

  it('closes the panel and rethrows a real failure', async () => {
    await expect(
      runRemoteDownloadWithProgress('a.bin', async (transfer) => {
        transfer.trackProgress(10).addBytes(1)
        throw new Error('Remote connection dropped')
      })
    ).rejects.toThrow('Remote connection dropped')
    expect(panel.close).toHaveBeenCalledTimes(1)
    expect(panel.settle).not.toHaveBeenCalled()
  })

  it('shows bytes without a percentage when the total is unknown', async () => {
    await runRemoteDownloadWithProgress('a.bin', async (transfer) => {
      transfer.trackProgress(null).addBytes(3)
      return { canceled: false, destinationPath: '/downloads/a.bin' }
    })
    expect(panel.updateRow).toHaveBeenCalledWith('d1', { sentBytes: 3, totalBytes: 0 })
  })

  it('never claims Cancelled when the download finished before the cancel landed', async () => {
    const result = await runRemoteDownloadWithProgress('a.bin', async (transfer) => {
      transfer.trackProgress(10).addBytes(10)
      // Why: the click arrives after promote; the result, not the click, decides the row.
      openPanel.mock.calls[0][2]('d1')
      return { canceled: false, destinationPath: '/downloads/a.bin' }
    })

    expect(result).toEqual({ canceled: false, destinationPath: '/downloads/a.bin' })
    expect(panel.updateRow).not.toHaveBeenCalledWith('d1', { status: 'cancelled' })
    expect(panel.close).toHaveBeenCalledTimes(1)
  })
})

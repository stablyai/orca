import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUploadProgressPanel } from './upload-progress-panel'

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
    openPanel: vi.fn((_rows: unknown[], _onCancel: (transferId: string) => void) => panel)
  }
})

vi.mock('./open-transfer-progress-panel', () => ({ openTransferProgressPanel: openPanel }))

const row = { uploadId: 'u1', name: 'videos', totalBytes: 0, sourcePath: '/local/videos' }

describe('createUploadProgressPanel', () => {
  const cancelRuntimeUpload = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    cancelRuntimeUpload.mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { fs: { cancelRuntimeUpload } } })
  })

  it('never opens a panel for a drop that staged nothing', () => {
    const upload = createUploadProgressPanel()
    upload.progress.onStart([])
    upload.progress.onFinish()
    upload.close()
    expect(openPanel).not.toHaveBeenCalled()
  })

  it('forwards row progress and the row outcome', () => {
    const upload = createUploadProgressPanel()
    upload.progress.onStart([row])
    upload.progress.onRowProgress('u1', 5)
    upload.progress.onRowProgress('u1', 6)
    upload.progress.onRowSettled('u1', 'done')
    upload.progress.onFinish()

    expect(openPanel).toHaveBeenCalledWith(
      [{ transferId: 'u1', name: 'videos', sentBytes: 0, totalBytes: 0, status: 'active' }],
      expect.any(Function),
      undefined
    )
    expect(panel.updateRow.mock.calls).toEqual([
      ['u1', { sentBytes: 5 }],
      ['u1', { sentBytes: 6 }],
      ['u1', { status: 'done' }]
    ])
    expect(panel.settle).toHaveBeenCalledTimes(1)
  })

  it('cancels a row in main and tells the import which row was cancelled', () => {
    const upload = createUploadProgressPanel()
    upload.progress.onStart([row])
    const cancel = openPanel.mock.calls[0][1]
    cancel('u1')

    expect(cancelRuntimeUpload).toHaveBeenCalledWith({ uploadId: 'u1' })
    // Why: the click only asks; the result decides the final state.
    expect(panel.markCancelling).toHaveBeenCalledWith('u1')
    expect(upload.progress.isCancelled?.('u1')).toBe(true)
    expect(upload.progress.isCancelled?.('u2')).toBe(false)
  })
})

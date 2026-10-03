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
    openPanel: vi.fn(
      (_direction: string, _rows: unknown[], _onCancel: (transferId: string) => void) => panel
    )
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

  it('takes a late total from SSH progress and keeps totals from runtime rows', () => {
    const upload = createUploadProgressPanel()
    upload.progress.onStart([row])
    upload.progress.onRowProgress('u1', 5, 10)
    upload.progress.onRowProgress('u1', 6)
    upload.progress.onRowSettled('u1', 'done')
    upload.progress.onFinish()

    expect(openPanel).toHaveBeenCalledWith(
      'upload',
      [{ transferId: 'u1', name: 'videos', sentBytes: 0, totalBytes: 0, status: 'active' }],
      expect.any(Function),
      undefined
    )
    expect(panel.updateRow.mock.calls).toEqual([
      ['u1', { sentBytes: 5, totalBytes: 10 }],
      ['u1', { sentBytes: 6 }],
      ['u1', { status: 'done' }]
    ])
    expect(panel.settle).toHaveBeenCalledTimes(1)
  })

  it('cancels a row in main and tells the import which row was cancelled', () => {
    const upload = createUploadProgressPanel()
    upload.progress.onStart([row])
    const cancel = openPanel.mock.calls[0][2]
    cancel('u1')

    expect(cancelRuntimeUpload).toHaveBeenCalledWith({ uploadId: 'u1' })
    // Why: the click only asks; the result decides the final state.
    expect(panel.markCancelling).toHaveBeenCalledWith('u1')
    expect(upload.progress.isCancelled?.('u1')).toBe(true)
    expect(upload.progress.isCancelled?.('u2')).toBe(false)
  })

  it('handles a failed cancel request and leaves the row cancelling', () => {
    const catchRejection = vi.fn()
    cancelRuntimeUpload.mockReturnValue({ catch: catchRejection })
    const upload = createUploadProgressPanel()
    upload.progress.onStart([row])
    openPanel.mock.calls[0][2]('u1')

    // Why: an unhandled rejection only fails the run, not this case, so run the handler here.
    const onRejected = catchRejection.mock.calls[0]?.[0]
    expect(() => onRejected(new Error('IPC unavailable'))).not.toThrow()
    expect(panel.markCancelling).toHaveBeenCalledTimes(1)
    expect(panel.updateRow).not.toHaveBeenCalled()
    expect(panel.settle).not.toHaveBeenCalled()
  })

  it('ends a cancelled source as cancelled, but one that finished anyway as done', () => {
    const upload = createUploadProgressPanel()
    upload.progress.onStart([row, { ...row, uploadId: 'u2', sourcePath: '/local/b.txt' }])
    const cancel = openPanel.mock.calls[0][2]
    cancel('u1')
    cancel('u2')

    upload.progress.onRowSettled('u1', 'failed')
    upload.progress.onRowSettled('u2', 'done')

    expect(panel.updateRow).toHaveBeenCalledWith('u1', { status: 'cancelled' })
    expect(panel.updateRow).toHaveBeenCalledWith('u2', { status: 'done' })
  })

  it('carries a folder kind learned from progress into the row', () => {
    const upload = createUploadProgressPanel()
    upload.progress.onStart([row])
    upload.progress.onRowProgress('u1', 0, 364, 'directory')

    expect(panel.updateRow).toHaveBeenCalledWith('u1', {
      sentBytes: 0,
      totalBytes: 364,
      kind: 'directory'
    })
  })

  it('keeps what a cancel had to leave on the host on the row, instead of hiding it', () => {
    const upload = createUploadProgressPanel()
    upload.progress.onStart([row])
    openPanel.mock.calls[0][2]('u1')

    upload.progress.onRowSettled(
      'u1',
      'failed',
      'Upload cancelled; partial upload left at /r/videos'
    )

    expect(panel.updateRow).toHaveBeenCalledWith('u1', {
      status: 'cancelled',
      detail: 'Upload cancelled; partial upload left at /r/videos'
    })
  })
})

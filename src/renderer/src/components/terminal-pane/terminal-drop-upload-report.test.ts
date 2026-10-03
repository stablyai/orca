import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  failuresToReport,
  reportTerminalDropUploadSkipsAndFailures
} from './terminal-drop-upload-report'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((key: string, fallback: string) => `${key}:${fallback}`)
}))

vi.mock('sonner', () => ({
  toast: {
    message: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: mocks.translate
}))

describe('reportTerminalDropUploadSkipsAndFailures', () => {
  beforeEach(() => {
    mocks.translate.mockClear()
    vi.mocked(toast.message).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it('uses distinct translation keys for symlink-only and mixed skipped uploads', () => {
    reportTerminalDropUploadSkipsAndFailures([{ reason: 'symlink' }], [])
    const symlinkOnlyKey = mocks.translate.mock.calls[0]?.[0]

    mocks.translate.mockClear()
    reportTerminalDropUploadSkipsAndFailures([{ reason: 'symlink' }, { reason: 'too_large' }], [])
    const mixedSkipKey = mocks.translate.mock.calls[0]?.[0]

    expect(symlinkOnlyKey).toBe('auto.components.terminal.pane.terminal.drop.handler.53f015fd85')
    expect(mixedSkipKey).toBe('auto.components.terminal.pane.terminal.drop.handler.b4cf68e889')
    expect(symlinkOnlyKey).not.toBe(mixedSkipKey)
    expect(toast.message).toHaveBeenCalledTimes(2)
  })

  it('reports upload failures without leaking individual paths', () => {
    reportTerminalDropUploadSkipsAndFailures([], [{ reason: '/secret/project/file.txt' }])

    expect(mocks.translate).toHaveBeenCalledWith(
      'auto.components.terminal.pane.terminal.drop.handler.1e072f611e',
      'Failed to upload {{value0}} {{value1}}.',
      { value0: 1, value1: 'file' }
    )
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining('/secret/project/file.txt'),
      { description: undefined }
    )
  })

  it('names a shared known skip reason', () => {
    reportTerminalDropUploadSkipsAndFailures(
      [{ reason: 'permission-denied' }, { reason: 'permission-denied' }],
      []
    )

    expect(toast.message).toHaveBeenCalledWith(
      'auto.components.terminal.pane.terminal.drop.handler.b4cf68e889:Skipped {{value0}} {{value1}}.',
      { description: 'auto.lib.dropSkipReason.permissionDenied:Permission denied.' }
    )
  })

  it('gives no reason for mixed, unknown, or symlink-only skips', () => {
    reportTerminalDropUploadSkipsAndFailures([{ reason: 'missing' }, { reason: 'symlink' }], [])
    reportTerminalDropUploadSkipsAndFailures([{ reason: 'too_large' }], [])
    reportTerminalDropUploadSkipsAndFailures([{ reason: 'symlink' }], [])

    expect(vi.mocked(toast.message).mock.calls.map((call) => call[1])).toEqual([
      { description: undefined },
      { description: undefined },
      { description: undefined }
    ])
  })

  it('names the workspace on a failure raised while the user is elsewhere', () => {
    reportTerminalDropUploadSkipsAndFailures([], [{ reason: 'a' }], 'Dropped into ux-polish')

    expect(toast.error).toHaveBeenCalledWith(expect.any(String), {
      description: 'Dropped into ux-polish'
    })
  })

  it('keeps upload wording for failures', () => {
    reportTerminalDropUploadSkipsAndFailures([], [{ reason: 'a' }, { reason: 'b' }])

    expect(mocks.translate).toHaveBeenCalledWith(
      'auto.components.terminal.pane.terminal.drop.handler.1e072f611e',
      'Failed to upload {{value0}} {{value1}}.',
      { value0: 2, value1: 'files' }
    )
  })
})

describe('reportTerminalDropUploadSkipsAndFailures leftovers', () => {
  it('names what a failure left on the host after the workspace', () => {
    vi.mocked(toast.error).mockClear()
    reportTerminalDropUploadSkipsAndFailures(
      [],
      [
        { reason: 'Upload cancelled; 3 partial items left under /r/out' },
        { reason: 'Upload cancelled; partial upload left at /r/a.bin' },
        { reason: 'disk full' }
      ],
      'Dropped into ux-polish'
    )

    expect(vi.mocked(toast.error).mock.calls[0]?.[1]).toEqual({
      description:
        'Dropped into ux-polish. Upload cancelled; 3 partial items left under /r/out (+1 more)'
    })
  })
})

describe('failuresToReport', () => {
  const cancelled = new Set(['/a', '/b'])
  const isCancelled = (item: { sourcePath: string }): boolean => cancelled.has(item.sourcePath)

  it('drops a clean cancel but keeps a cancel that left files and every real failure', () => {
    const failed = [
      { sourcePath: '/a', reason: 'Upload cancelled' },
      { sourcePath: '/b', reason: 'Upload cancelled; partial upload left at /r/b.bin' },
      { sourcePath: '/c', reason: 'disk full' }
    ]

    expect(failuresToReport(failed, isCancelled).map((item) => item.sourcePath)).toEqual([
      '/b',
      '/c'
    ])
  })
})

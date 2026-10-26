import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'

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
      { description: expect.not.stringContaining('/secret/project/file.txt') }
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

  it('keeps upload wording for failures', () => {
    reportTerminalDropUploadSkipsAndFailures([], [{ reason: 'a' }, { reason: 'b' }])

    expect(mocks.translate).toHaveBeenCalledWith(
      'auto.components.terminal.pane.terminal.drop.handler.1e072f611e',
      'Failed to upload {{value0}} {{value1}}.',
      { value0: 2, value1: 'files' }
    )
  })

  it('names a shared failure category, never the host text', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportTerminalDropUploadSkipsAndFailures(
      [],
      [{ reason: "Error invoking remote method 'fs:x': Error: ENOSPC: no space left on device" }]
    )
    reportTerminalDropUploadSkipsAndFailures(
      [],
      [{ reason: 'EACCES: permission denied, open \'/home/John Doe/Client "Acme"/shot.png\'' }]
    )
    reportTerminalDropUploadSkipsAndFailures(
      [],
      [{ reason: 'C:\\Users\\John Doe\\Application Support\\shot.png: unexpected' }]
    )
    reportTerminalDropUploadSkipsAndFailures(
      [],
      [{ reason: "File changed since it was staged: 'disconnect-notes.txt'" }]
    )
    reportTerminalDropUploadSkipsAndFailures(
      [],
      [{ reason: 'Runtime environment is manually disconnected.' }]
    )
    reportTerminalDropUploadSkipsAndFailures([], [{ reason: 'a' }, { reason: 'b' }])

    expect(vi.mocked(toast.error).mock.calls.map((call) => call[1])).toEqual([
      { description: 'auto.lib.dropFailureReason.noSpace:The host is out of disk space.' },
      { description: 'auto.lib.dropSkipReason.permissionDenied:Permission denied.' },
      { description: "auto.lib.dropFailureReason.unknownOne:Couldn't upload this file." },
      {
        description:
          'auto.lib.dropFailureReason.changed:The file changed while it was uploading. Try again.'
      },
      { description: 'auto.lib.dropFailureReason.disconnected:The host is disconnected.' },
      { description: undefined }
    ])
  })
})

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

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

    expect(symlinkOnlyKey).toBe(
      'auto.components.terminal.pane.terminal.drop.handler.skippedOneSymlink'
    )
    expect(mixedSkipKey).toBe(
      'auto.components.terminal.pane.terminal.drop.handler.skippedManyItems'
    )
    expect(symlinkOnlyKey).not.toBe(mixedSkipKey)
    expect(toast.message).toHaveBeenCalledTimes(2)
  })

  it('uses complete plural messages for multiple symlinks', () => {
    reportTerminalDropUploadSkipsAndFailures([{ reason: 'symlink' }, { reason: 'symlink' }], [])

    expect(mocks.translate).toHaveBeenCalledWith(
      'auto.components.terminal.pane.terminal.drop.handler.skippedManySymlinks',
      'Skipped {{count}} symlinks.',
      { count: 2 }
    )
  })

  it('reports upload failures without leaking individual paths', () => {
    reportTerminalDropUploadSkipsAndFailures([], [{ reason: '/secret/project/file.txt' }])

    expect(mocks.translate).toHaveBeenCalledWith(
      'auto.components.terminal.pane.terminal.drop.handler.failedToUploadOneFile',
      'Failed to upload {{count}} file.',
      { count: 1 }
    )
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining('/secret/project/file.txt')
    )
  })

  it('uses a complete plural failure message', () => {
    reportTerminalDropUploadSkipsAndFailures([], [{ reason: 'one' }, { reason: 'two' }])

    expect(mocks.translate).toHaveBeenCalledWith(
      'auto.components.terminal.pane.terminal.drop.handler.failedToUploadManyFiles',
      'Failed to upload {{count}} files.',
      { count: 2 }
    )
  })
})

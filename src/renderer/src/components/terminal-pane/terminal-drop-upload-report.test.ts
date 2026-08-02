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
      expect.not.stringContaining('/secret/project/file.txt')
    )
  })
})

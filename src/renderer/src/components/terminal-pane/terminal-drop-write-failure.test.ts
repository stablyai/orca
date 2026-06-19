import { afterEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastError
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { showTerminalDropWriteFailure } from './terminal-drop-write-failure'

afterEach(() => {
  toastError.mockClear()
})

describe('terminal drop write failure notification', () => {
  it('does not show an error for stale targets', () => {
    showTerminalDropWriteFailure('target-stale')
    showTerminalDropWriteFailure(undefined)

    expect(toastError).not.toHaveBeenCalled()
  })

  it('shows a timeout error without dropped path content', () => {
    showTerminalDropWriteFailure('operation-timeout')

    expect(toastError).toHaveBeenCalledWith(
      'File drop cancelled: terminal did not accept the path before the safety timeout.'
    )
  })

  it('shows a rejected-write error without dropped path content', () => {
    showTerminalDropWriteFailure('write-rejected')

    expect(toastError).toHaveBeenCalledWith(
      'File drop cancelled: terminal could not accept the path.'
    )
  })
})

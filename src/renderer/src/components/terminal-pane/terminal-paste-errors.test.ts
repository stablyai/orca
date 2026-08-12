// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMessage = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    message: (...args: unknown[]) => toastMessage(...args)
  }
}))

import {
  TERMINAL_PASTE_CANCELLED_TOAST_ID,
  formatTerminalPasteExecutionError,
  isTransientTerminalPasteCancellation,
  isTransientTerminalPasteCancellationMessage,
  reportTerminalPasteExecutionOutcome
} from './terminal-paste-errors'

beforeEach(() => {
  toastMessage.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('formatTerminalPasteExecutionError', () => {
  it('formats focus-change cancellation without clipboard content', () => {
    expect(formatTerminalPasteExecutionError('stale-target')).toBe(
      'Paste cancelled: terminal focus changed before paste started.'
    )
  })

  it('formats durable paste failures', () => {
    expect(formatTerminalPasteExecutionError('payload-too-large')).toBe(
      'Paste failed: clipboard text is too large for a safe terminal paste.'
    )
    expect(formatTerminalPasteExecutionError('pty-writer-unavailable')).toBe(
      'Paste failed: terminal is not ready for large paste.'
    )
    expect(formatTerminalPasteExecutionError(undefined)).toBe('Paste failed.')
  })
})

describe('isTransientTerminalPasteCancellation', () => {
  it('treats focus, disconnect, and timeout cancels as transient', () => {
    expect(isTransientTerminalPasteCancellation('stale-target')).toBe(true)
    expect(isTransientTerminalPasteCancellation('target-disconnected')).toBe(true)
    expect(isTransientTerminalPasteCancellation('operation-timeout')).toBe(true)
  })

  it('keeps hard paste failures durable', () => {
    expect(isTransientTerminalPasteCancellation('payload-too-large')).toBe(false)
    expect(isTransientTerminalPasteCancellation('pty-writer-unavailable')).toBe(false)
    expect(isTransientTerminalPasteCancellation('paste-rejected')).toBe(false)
    expect(isTransientTerminalPasteCancellation(undefined)).toBe(false)
  })
})

describe('isTransientTerminalPasteCancellationMessage', () => {
  it('matches a pure single paste-cancellation line', () => {
    expect(
      isTransientTerminalPasteCancellationMessage(
        'Paste cancelled: terminal focus changed before paste started.'
      )
    ).toBe(true)
  })

  it('matches multiple pure paste-cancellation lines without stacking classification', () => {
    expect(
      isTransientTerminalPasteCancellationMessage(
        [
          'Paste cancelled: terminal focus changed before paste started.',
          'Paste cancelled: terminal disconnected before paste completed.',
          'Paste cancelled: terminal did not accept paste before the safety timeout.'
        ].join('\n')
      )
    ).toBe(true)
  })

  it('keeps mixed durable+cancel aggregates durable (fail-closed)', () => {
    expect(
      isTransientTerminalPasteCancellationMessage(
        'Paste failed.\nPaste cancelled: terminal disconnected before paste completed.'
      )
    ).toBe(false)
    expect(
      isTransientTerminalPasteCancellationMessage(
        'Paste cancelled: terminal focus changed before paste started.\nPaste failed.'
      )
    ).toBe(false)
    expect(
      isTransientTerminalPasteCancellationMessage(
        'node-pty: open_slave failed: EMFILE\nPaste cancelled: terminal focus changed before paste started.'
      )
    ).toBe(false)
  })

  it('ignores durable paste failures and empty aggregates', () => {
    expect(isTransientTerminalPasteCancellationMessage('Paste failed.')).toBe(false)
    expect(
      isTransientTerminalPasteCancellationMessage(
        'Paste failed: clipboard text is too large for a safe terminal paste.'
      )
    ).toBe(false)
    expect(isTransientTerminalPasteCancellationMessage('')).toBe(false)
    expect(isTransientTerminalPasteCancellationMessage('\n\n')).toBe(false)
  })
})

describe('reportTerminalPasteExecutionOutcome', () => {
  it('emits a one-shot auto-dismiss toast for focus-change cancellation', () => {
    const onPersistentError = vi.fn()
    reportTerminalPasteExecutionOutcome('stale-target', onPersistentError)

    expect(onPersistentError).not.toHaveBeenCalled()
    expect(toastMessage).toHaveBeenCalledTimes(1)
    expect(toastMessage).toHaveBeenCalledWith(
      'Paste cancelled: terminal focus changed before paste started.',
      {
        id: TERMINAL_PASTE_CANCELLED_TOAST_ID,
        duration: 4_000
      }
    )
  })

  it('does not park focus-change cancellation on the durable error banner', () => {
    const onPersistentError = vi.fn()
    reportTerminalPasteExecutionOutcome('stale-target', onPersistentError)
    reportTerminalPasteExecutionOutcome('target-disconnected', onPersistentError)
    reportTerminalPasteExecutionOutcome('operation-timeout', onPersistentError)

    expect(onPersistentError).not.toHaveBeenCalled()
    expect(toastMessage).toHaveBeenCalledTimes(3)
  })

  it('routes durable paste failures to the persistent error surface', () => {
    const onPersistentError = vi.fn()
    reportTerminalPasteExecutionOutcome('payload-too-large', onPersistentError)

    expect(toastMessage).not.toHaveBeenCalled()
    expect(onPersistentError).toHaveBeenCalledWith(
      'Paste failed: clipboard text is too large for a safe terminal paste.'
    )
  })
})

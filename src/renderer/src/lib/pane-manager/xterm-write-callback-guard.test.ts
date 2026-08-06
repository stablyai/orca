import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWriteCompletionReportsForTests,
  runGuardedWriteCompletionStep
} from './xterm-write-callback-guard'
import { writeForegroundTerminalChunk } from './pane-terminal-foreground-render-settle'

const mocks = vi.hoisted(() => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

beforeEach(() => {
  mocks.recordRendererCrashBreadcrumb.mockClear()
  _resetWriteCompletionReportsForTests()
})

describe('runGuardedWriteCompletionStep', () => {
  it('contains a synchronous throw and reports a breadcrumb', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        runGuardedWriteCompletionStep('test-step', () => {
          throw new RangeError('synthetic settle failure')
        })
      ).not.toThrow()
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_write_completion_error',
        expect.objectContaining({
          context: 'test-step',
          errorName: 'RangeError',
          errorMessage: 'synthetic settle failure'
        })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('caps repeated reports per context so a throw-per-write loop cannot spam breadcrumbs', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let i = 0; i < 20; i++) {
        runGuardedWriteCompletionStep('spammy-step', () => {
          throw new Error('always fails')
        })
      }
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(5)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('runs non-throwing steps transparently', () => {
    const step = vi.fn()
    runGuardedWriteCompletionStep('ok-step', step)
    expect(step).toHaveBeenCalledTimes(1)
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
  })
})

describe('writeForegroundTerminalChunk completion guarding', () => {
  it('reports a synchronous write failure without claiming parse completion', () => {
    const terminal = {
      write: vi.fn(() => {
        throw new Error('terminal disposed')
      })
    }
    const onParsed = vi.fn()
    const onWriteFailure = vi.fn()

    expect(() =>
      writeForegroundTerminalChunk(terminal, 'rejected bytes', {
        onParsed,
        onWriteFailure
      })
    ).not.toThrow()

    expect(onWriteFailure).toHaveBeenCalledTimes(1)
    expect(onParsed).not.toHaveBeenCalled()
  })

  it('still releases onParsed when the settle step throws (replay-guard latch protection)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pendingCallbacks: (() => void)[] = []
      // Why a getter that throws only after the write is dispatched: it
      // models renderer/buffer state failing between parse start and the
      // post-parse viewport settle (refreshVisibleRowsNow self-catches, so
      // the viewport comparison is the escaping surface).
      let bufferAccessPoisoned = false
      const realBuffer = { active: { cursorY: 0, baseY: 0, viewportY: 0 } }
      const terminal = {
        rows: 24,
        get buffer() {
          if (bufferAccessPoisoned) {
            throw new Error('synthetic buffer access failure')
          }
          return realBuffer
        },
        write: (_data: string, cb?: () => void) => {
          if (cb) {
            pendingCallbacks.push(cb)
          }
        }
      }
      const onParsed = vi.fn()

      writeForegroundTerminalChunk(terminal, 'restored bytes', {
        forceViewportRefresh: true,
        onParsed
      })
      bufferAccessPoisoned = true
      // Simulate xterm completing the parse: the completion callback must not
      // let the settle throw escape into the WriteBuffer, and onParsed (the
      // replay-guard release) must still run.
      expect(() => pendingCallbacks.forEach((cb) => cb())).not.toThrow()
      expect(onParsed).toHaveBeenCalledTimes(1)
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_write_completion_error',
        expect.objectContaining({ context: 'foreground-render-settle' })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})

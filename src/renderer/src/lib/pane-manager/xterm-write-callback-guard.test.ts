import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetWriteCompletionReportsForTests } from './xterm-write-callback-guard'
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
      // Throw after dispatch to model buffer/renderer failure during post-parse settle; refresh self-catches, so viewport comparison exposes the escaping path.
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
      // Settle failure must not escape into WriteBuffer or starve onParsed’s replay-guard release.
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

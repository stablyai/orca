import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  _resetParserHandlerReportsForTests,
  guardParserHandler
} from './terminal-parser-handler-guard'

const mocks = vi.hoisted(() => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

beforeEach(() => {
  mocks.recordRendererCrashBreadcrumb.mockClear()
  _resetParserHandlerReportsForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('guardParserHandler', () => {
  it('passes arguments and return value through for healthy handlers', () => {
    const handler = vi.fn((data: string) => data === 'handled')
    const guarded = guardParserHandler('test-handler', handler)
    expect(guarded('handled')).toBe(true)
    expect(guarded('other')).toBe(false)
    expect(handler).toHaveBeenCalledTimes(2)
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('degrades a throwing handler to "not handled" and reports a breadcrumb', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const guarded = guardParserHandler('exploding-handler', () => {
        throw new TypeError('synthetic handler failure')
      })
      expect(guarded()).toBe(false)
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_parser_handler_error',
        expect.objectContaining({
          handler: 'exploding-handler',
          errorName: 'TypeError',
          errorMessage: 'synthetic handler failure'
        })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('caps repeated reports per handler', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const guarded = guardParserHandler('spammy-handler', () => {
        throw new Error('always fails')
      })
      for (let i = 0; i < 20; i++) {
        guarded()
      }
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(5)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('keeps the real xterm write pipeline alive through a throwing handler (inverse of the wedge repro)', () => {
    // Why: xterm-write-buffer-stall.repro.test.ts proves an UNguarded throwing
    // handler permanently wedges the WriteBuffer. This is the fix's proof:
    // the same poison sequence through a GUARDED handler keeps completing
    // writes.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.useFakeTimers()
      const term = new Terminal({ allowProposedApi: true })
      const completed: string[] = []
      term.parser.registerCsiHandler(
        { final: 'z' },
        guardParserHandler('poisoned-csi', () => {
          throw new Error('synthetic parser handler failure')
        })
      )

      term.write('\x1b[z', () => {
        completed.push('poisoned')
      })
      term.write('after', () => {
        completed.push('after')
      })
      expect(() => vi.runAllTimers()).not.toThrow()

      term.write('later', () => {
        completed.push('later')
      })
      vi.runAllTimers()
      expect(completed).toEqual(['poisoned', 'after', 'later'])
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_parser_handler_error',
        expect.objectContaining({ handler: 'poisoned-csi' })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})

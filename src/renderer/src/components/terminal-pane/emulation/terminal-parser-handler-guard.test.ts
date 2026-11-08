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
  it('keeps the real xterm write pipeline alive through a throwing handler (inverse of the wedge repro)', () => {
    // The unguarded handler wedges WriteBuffer; require guarded poison sequences to keep completing writes.
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

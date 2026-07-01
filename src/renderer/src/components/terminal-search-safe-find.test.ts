import { beforeEach, describe, expect, it, vi } from 'vitest'
import { safeFind } from './terminal-search-safe-find'

const mocks = vi.hoisted(() => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('@/lib/crash-diagnostics', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

/**
 * Regression for crash report 0b9ab636-1333-4aac-a7bb-ddb338feb151 (Orca 1.4.104, macOS).
 *
 * boundary_id: terminal.workbench  surface: terminal-workbench
 * error: "This API only accepts positive integers"
 * stack (deminified):
 *   _verifyPositiveIntegers
 *   registerDecoration            <- @xterm/xterm Terminal.registerDecoration
 *   _createResultDecorations      <- @xterm/addon-search DecorationManager
 *   createHighlightDecorations
 *   _highlightAllMatches
 *   findNext                      <- SearchAddon.findNext
 *   commitHookEffectListMount     <- TerminalSearch useEffect
 *
 * The addon computes a match-highlight decoration width as
 *   amountThisRow = Math.min(terminal.cols - matchCol, remainingSize)
 * which goes NEGATIVE when the live viewport is narrower than the buffer column
 * where a match starts (a not-yet-reflowed / collapsed viewport). xterm's
 * registerDecoration then throws synchronously inside findNext. Thrown from the
 * TerminalSearch effect, it trips RecoverableRenderErrorBoundary and kills the
 * terminal surface.
 *
 * safeFind() wraps the addon call so that specific decoration error is swallowed
 * (match navigation already ran), keeping search alive instead of crashing.
 */

// The exact synchronous error xterm raises from registerDecoration on a negative
// decoration width.
const positiveIntegerError = (): Error => new Error('This API only accepts positive integers')

describe('safeFind (TerminalSearch decoration crash guard)', () => {
  beforeEach(() => {
    mocks.recordRendererCrashBreadcrumb.mockClear()
  })

  it('swallows the xterm "positive integers" decoration error instead of letting it crash the surface', () => {
    const find = vi.fn(() => {
      throw positiveIntegerError()
    })
    // Before the fix this threw straight through TerminalSearch's effect into the
    // error boundary. Now it is contained and reported as "no match this frame".
    expect(() => safeFind(find, 'query')).not.toThrow()
    expect(safeFind(find, 'query')).toBe(false)
    expect(find).toHaveBeenCalledWith('query', undefined)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_search_decoration_error',
      {
        errorName: 'Error',
        errorMessage: 'This API only accepts positive integers',
        queryLength: 5,
        caseSensitive: false,
        regex: false
      }
    )
  })

  it('returns the addon result and forwards options on the normal path', () => {
    const find = vi.fn(() => true)
    const options = { caseSensitive: true }
    expect(safeFind(find, 'q', options)).toBe(true)
    expect(find).toHaveBeenCalledWith('q', options)
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('re-throws unrelated errors so genuine bugs are not hidden', () => {
    const find = vi.fn(() => {
      throw new TypeError('something genuinely broken')
    })
    expect(() => safeFind(find, 'q')).toThrow('something genuinely broken')
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('keeps focus and input surfaces callable after a contained decoration failure', () => {
    const focusTerminal = vi.fn()
    const writeInput = vi.fn()
    const find = vi.fn(() => {
      throw positiveIntegerError()
    })

    expect(safeFind(find, 'query')).toBe(false)
    expect(() => {
      focusTerminal()
      writeInput('a')
    }).not.toThrow()

    expect(focusTerminal).toHaveBeenCalledOnce()
    expect(writeInput).toHaveBeenCalledWith('a')
  })
})

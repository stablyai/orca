import { describe, expect, it, vi } from 'vitest'
import { safeFind } from './terminal-search-safe-find'

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
  it('swallows the xterm "positive integers" decoration error instead of letting it crash the surface', () => {
    const find = vi.fn(() => {
      throw positiveIntegerError()
    })
    // Before the fix this threw straight through TerminalSearch's effect into the
    // error boundary. Now it is contained and reported as "no match this frame".
    expect(() => safeFind(find, 'query')).not.toThrow()
    expect(safeFind(find, 'query')).toBe(false)
    expect(find).toHaveBeenCalledWith('query', undefined)
  })

  it('returns the addon result and forwards options on the normal path', () => {
    const find = vi.fn(() => true)
    const options = { caseSensitive: true }
    expect(safeFind(find, 'q', options)).toBe(true)
    expect(find).toHaveBeenCalledWith('q', options)
  })

  it('re-throws unrelated errors so genuine bugs are not hidden', () => {
    const find = vi.fn(() => {
      throw new TypeError('something genuinely broken')
    })
    expect(() => safeFind(find, 'q')).toThrow('something genuinely broken')
  })
})

/**
 * Regression for STA-6256 (reproduced live on main 573537ecd4, crash report
 * 812e673e-3a47-438f-9755-9e9e36279205, boundary_id terminal.workbench):
 * typing an invalid pattern with the Regex toggle on crashed the whole
 * workspace workbench with "SyntaxError: Invalid regular expression: /[/gi:
 * Unterminated character class".
 *
 * The addon compiles the raw query as `RegExp(term, caseSensitive ? 'g' : 'gi')`
 * with no guard, so these tests throw the real compile error rather than a
 * hand-written lookalike — a message-only fixture would still pass if the addon
 * changed which error it raises.
 */
describe('safeFind (invalid regex crash guard)', () => {
  // Exactly how @xterm/addon-search builds the matcher in regex mode.
  const compileLikeAddon = (term: string, caseSensitive = false): boolean =>
    RegExp(term, caseSensitive ? 'g' : 'gi').test('haystack')

  // Every one of these is a prefix of a pattern a user is part-way through typing.
  it.each(['[', '(', '*', '\\', '[a-', '(?<'])(
    'contains the real SyntaxError from partially-typed pattern %j instead of crashing the surface',
    (term) => {
      const find = vi.fn((t: string) => compileLikeAddon(t))
      // Guard the premise: this pattern really is uncompilable, so the test is
      // exercising the throw path rather than passing vacuously.
      expect(() => RegExp(term, 'gi')).toThrow(SyntaxError)
      expect(() => safeFind(find, term)).not.toThrow()
      expect(safeFind(find, term)).toBe(false)
      expect(find).toHaveBeenCalledWith(term, undefined)
    }
  )

  it('still finds matches once the pattern becomes valid', () => {
    const find = vi.fn((t: string) => compileLikeAddon(t))
    expect(safeFind(find, '[')).toBe(false)
    // The completed pattern must search normally - the guard must not latch.
    expect(safeFind(find, '[abc]')).toBe(true)
  })

  it('re-throws a SyntaxError that is not a regex compile failure', () => {
    const find = vi.fn(() => {
      throw new SyntaxError('Unexpected token } in JSON at position 4')
    })
    expect(() => safeFind(find, 'q')).toThrow('Unexpected token }')
  })
})

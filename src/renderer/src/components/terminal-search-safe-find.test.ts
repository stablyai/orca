import { describe, expect, it, vi } from 'vitest'
import { safeFind } from './terminal-search-safe-find'

/** A viewport narrower than a stored match makes addon decoration width negative and throws from registerDecoration (crash 0b9ab636). safeFind must contain that failure without killing the terminal surface. */

// Match xterm’s exact synchronous negative-decoration-width error.
const positiveIntegerError = (): Error => new Error('This API only accepts positive integers')

describe('safeFind (TerminalSearch decoration crash guard)', () => {
  it('swallows the xterm "positive integers" decoration error instead of letting it crash the surface', () => {
    const find = vi.fn(() => {
      throw positiveIntegerError()
    })
    // Contain decoration failure as no match this frame instead of tripping the terminal error boundary.
    expect(() => safeFind(find, 'query')).not.toThrow()
    expect(safeFind(find, 'query')).toBe(false)
    expect(find).toHaveBeenCalledWith('query', undefined)
  })

  it('re-throws unrelated errors so genuine bugs are not hidden', () => {
    const find = vi.fn(() => {
      throw new TypeError('something genuinely broken')
    })
    expect(() => safeFind(find, 'q')).toThrow('something genuinely broken')
  })
})

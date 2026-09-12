import { describe, expect, it } from 'vitest'
import { deliveredFinalPressAbort } from './computer-coordinate-click-driver'

function fenceAbort(data?: Record<string, unknown>): string {
  return JSON.stringify({
    ok: false,
    error: { code: 'window_not_focused', data }
  })
}

describe('deliveredFinalPressAbort', () => {
  it('accepts only an after-press abort with the exact planned count', () => {
    expect(
      deliveredFinalPressAbort(fenceAbort({ deliveredPresses: 2, phase: 'after-press' }), 2)
    ).toBe(true)
    expect(
      deliveredFinalPressAbort(fenceAbort({ deliveredPresses: 1, phase: 'after-press' }), 2)
    ).toBe(false)
    expect(
      deliveredFinalPressAbort(fenceAbort({ deliveredPresses: 2, phase: 'before-press' }), 2)
    ).toBe(false)
  })

  it('fails closed for absent, malformed, or unrelated diagnostics', () => {
    expect(deliveredFinalPressAbort(fenceAbort(), 1)).toBe(false)
    expect(deliveredFinalPressAbort('{not json', 1)).toBe(false)
    expect(
      deliveredFinalPressAbort(
        JSON.stringify({
          ok: false,
          error: {
            code: 'accessibility_error',
            data: { deliveredPresses: 1, phase: 'after-press' }
          }
        }),
        1
      )
    ).toBe(false)
    expect(
      deliveredFinalPressAbort(fenceAbort({ deliveredPresses: 1, phase: 'after-press' }), 0)
    ).toBe(false)
  })
})

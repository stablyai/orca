import { describe, expect, it } from 'vitest'
import { resolveModifierRouting } from './http-link-routing'

describe('resolveModifierRouting', () => {
  it('is inert without the modifier regardless of settings', () => {
    for (const openLinksInApp of [true, false]) {
      for (const inverts of [true, false]) {
        expect(resolveModifierRouting(false, openLinksInApp, inverts)).toEqual({
          wantsOrca: false,
          wantsSystemBrowser: false
        })
      }
    }
  })

  // Why: the setting ships off, so the historical one-way escape hatch must be
  // byte-for-byte unchanged for every existing user.
  it('always forces the system browser when inverting is off', () => {
    expect(resolveModifierRouting(true, true, false)).toEqual({
      wantsOrca: false,
      wantsSystemBrowser: true
    })
    expect(resolveModifierRouting(true, false, false)).toEqual({
      wantsOrca: false,
      wantsSystemBrowser: true
    })
  })

  it('still reaches the system browser when inverting and links open in Orca', () => {
    expect(resolveModifierRouting(true, true, true)).toEqual({
      wantsOrca: false,
      wantsSystemBrowser: true
    })
  })

  it('reaches Orca when inverting and links open in the system browser', () => {
    expect(resolveModifierRouting(true, false, true)).toEqual({
      wantsOrca: true,
      wantsSystemBrowser: false
    })
  })

  it('only diverges from the legacy behavior when links open externally', () => {
    expect(resolveModifierRouting(true, true, true)).toEqual(
      resolveModifierRouting(true, true, false)
    )
    expect(resolveModifierRouting(true, false, true)).not.toEqual(
      resolveModifierRouting(true, false, false)
    )
  })
})

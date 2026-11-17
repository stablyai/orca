import { describe, expect, it } from 'vitest'
import { signedInSince } from './use-retry-after-cloud-sign-in'

describe('signedInSince', () => {
  it('fires when sign-in completes, wherever it was started', () => {
    expect(signedInSince('signed-out', 'connected')).toBe(true)
    expect(signedInSince(undefined, 'connected')).toBe(true)
  })

  it('does not fire again while already signed in, or on sign-out', () => {
    expect(signedInSince('connected', 'connected')).toBe(false)
    expect(signedInSince('connected', 'signed-out')).toBe(false)
  })
})

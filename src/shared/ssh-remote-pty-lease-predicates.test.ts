import { describe, expect, it } from 'vitest'
import { isLiveSshPtyLease } from './ssh-types'

describe('isLiveSshPtyLease', () => {
  it.each([
    ['attached', true],
    ['detached', true],
    ['expired', false],
    ['terminated', false]
  ] as const)('reads a %s lease as live: %s', (state, live) => {
    expect(isLiveSshPtyLease({ state })).toBe(live)
  })
})

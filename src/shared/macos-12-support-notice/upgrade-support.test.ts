import { describe, expect, it } from 'vitest'
import { isMacos12SupportNoticeEligible } from './upgrade-support'

describe('macOS support notice', () => {
  it.each([
    ['darwin', '12.7.6', false, true],
    ['darwin', '12.7.6', true, false],
    ['darwin', '13.0', false, false],
    ['darwin', '21.6.0', false, false],
    ['darwin', '', false, false],
    ['linux', '12.0', false, false],
    ['win32', '12.0', false, false]
  ])('targets local Monterey only: %s %s web=%s', (platform, osRelease, webClient, eligible) => {
    expect(isMacos12SupportNoticeEligible({ platform, osRelease }, webClient)).toBe(eligible)
  })
})

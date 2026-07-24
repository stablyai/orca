import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isBehindOnlyUpstream,
  shouldForcePushWithLeaseForUpstream,
  upstreamOnlyCommitsArePatchEquivalent
} from './git-upstream-status'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('upstreamOnlyCommitsArePatchEquivalent', () => {
  it('returns true when every upstream-only commit is patch-equivalent', () => {
    expect(upstreamOnlyCommitsArePatchEquivalent('= abc\n= def\n')).toBe(true)
  })

  it('returns false for empty output or non-equivalent commits', () => {
    expect(upstreamOnlyCommitsArePatchEquivalent('')).toBe(false)
    expect(upstreamOnlyCommitsArePatchEquivalent('= abc\n+ def\n')).toBe(false)
  })

  it('scans newline-heavy cherry output without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const output = `${'\r\n'.repeat(10_000)}= abc\r\n= def\r\n`

    expect(upstreamOnlyCommitsArePatchEquivalent(output)).toBe(true)

    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && separator === '\n') ||
        (separator instanceof RegExp && separator.source === '\\r?\\n')
    )
    expect(usedLineSplit).toBe(false)
  })
})

describe('shouldForcePushWithLeaseForUpstream', () => {
  it('requires a diverged upstream with patch-equivalent behind commits', () => {
    expect(
      shouldForcePushWithLeaseForUpstream({
        hasUpstream: true,
        ahead: 1,
        behind: 1,
        behindCommitsArePatchEquivalent: true
      })
    ).toBe(true)
    expect(
      shouldForcePushWithLeaseForUpstream({
        hasUpstream: true,
        ahead: 1,
        behind: 1,
        behindCommitsArePatchEquivalent: false
      })
    ).toBe(false)
  })
})

describe('isBehindOnlyUpstream', () => {
  it('is true only when the branch tracks upstream and is purely behind', () => {
    expect(
      isBehindOnlyUpstream({
        hasUpstream: true,
        ahead: 0,
        behind: 3
      })
    ).toBe(true)
    expect(
      isBehindOnlyUpstream({
        hasUpstream: true,
        ahead: 1,
        behind: 2
      })
    ).toBe(false)
    expect(
      isBehindOnlyUpstream({
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).toBe(false)
    expect(
      isBehindOnlyUpstream({
        hasUpstream: false,
        ahead: 0,
        behind: 3
      })
    ).toBe(false)
    expect(isBehindOnlyUpstream(undefined)).toBe(false)
  })
})

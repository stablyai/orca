import { describe, expect, it } from 'vitest'
import { readBranchNameFromFullRef, repairAbbreviatedRefName } from './git-abbreviated-ref-repair'

const FULL_CHINESE_BRANCH = 'sprint139/m-7109863708-【渠道】CRM营销工具接口变动与代付发券替换PRD'

/**
 * How the truncated name actually reaches Orca: git cuts the bytes at the 0xA0 its
 * libc calls whitespace (`渠` is E6 B8 A0), then Node decodes the severed sequence
 * lossily into a trailing U+FFFD.
 */
function truncateMidUtf8(name: string): string {
  const bytes = Buffer.from(name, 'utf8')
  const cut = bytes.indexOf(0xa0)
  expect(cut).toBeGreaterThan(0)
  return bytes.subarray(0, cut).toString('utf8')
}

describe('repairAbbreviatedRefName', () => {
  it('leaves an intact abbreviated name unchanged', () => {
    expect(repairAbbreviatedRefName('refs/heads/main', 'main')).toBe('main')
    expect(repairAbbreviatedRefName('refs/remotes/origin/main', 'origin/main')).toBe('origin/main')
    expect(repairAbbreviatedRefName('refs/tags/v1.0.0', 'v1.0.0')).toBe('v1.0.0')
  })

  it('leaves an intact non-ASCII name unchanged', () => {
    expect(repairAbbreviatedRefName(`refs/heads/${FULL_CHINESE_BRANCH}`, FULL_CHINESE_BRANCH)).toBe(
      FULL_CHINESE_BRANCH
    )
  })

  it('keeps git disambiguation prefixes that are part of the abbreviated name', () => {
    // A branch and a tag both named `release` make git print `heads/release`.
    expect(repairAbbreviatedRefName('refs/heads/release', 'heads/release')).toBe('heads/release')
    expect(repairAbbreviatedRefName('refs/remotes/origin/x', 'remotes/origin/x')).toBe(
      'remotes/origin/x'
    )
  })

  it('restores a local branch git cut mid-UTF-8', () => {
    const truncated = truncateMidUtf8(FULL_CHINESE_BRANCH)
    expect(truncated).not.toBe(FULL_CHINESE_BRANCH)
    expect(truncated).toContain('�')
    expect(repairAbbreviatedRefName(`refs/heads/${FULL_CHINESE_BRANCH}`, truncated)).toBe(
      FULL_CHINESE_BRANCH
    )
  })

  it('restores a remote-tracking branch git cut mid-UTF-8', () => {
    const shortName = `origin/${FULL_CHINESE_BRANCH}`
    expect(
      repairAbbreviatedRefName(
        `refs/remotes/origin/${FULL_CHINESE_BRANCH}`,
        truncateMidUtf8(shortName)
      )
    ).toBe(shortName)
  })

  it('restores a tag git cut mid-UTF-8', () => {
    expect(
      repairAbbreviatedRefName(
        `refs/tags/${FULL_CHINESE_BRANCH}`,
        truncateMidUtf8(FULL_CHINESE_BRANCH)
      )
    ).toBe(FULL_CHINESE_BRANCH)
  })

  it('restores a name cut before any multi-byte character', () => {
    expect(repairAbbreviatedRefName('refs/heads/feature/x', 'feature/')).toBe('feature/x')
  })

  it('prefers the shortest namespace-stripped candidate', () => {
    // `refs/heads/heads/x` abbreviates to `heads/x`, not `heads/heads/x`.
    expect(repairAbbreviatedRefName('refs/heads/heads/x', 'heads')).toBe('heads/x')
  })

  it('returns the abbreviated value when the pair is unrelated', () => {
    expect(repairAbbreviatedRefName('refs/heads/main', 'other')).toBe('other')
  })

  it('returns the abbreviated value for empty inputs', () => {
    expect(repairAbbreviatedRefName('', 'main')).toBe('main')
    expect(repairAbbreviatedRefName('refs/heads/main', '')).toBe('')
  })

  it('returns the abbreviated value when it is nothing but replacement characters', () => {
    expect(repairAbbreviatedRefName('refs/heads/main', '�')).toBe('�')
  })

  it('never shortens the name git returned', () => {
    for (const name of ['main', 'feature/a', FULL_CHINESE_BRANCH]) {
      expect(repairAbbreviatedRefName(`refs/heads/${name}`, name)).toBe(name)
    }
  })
})

describe('readBranchNameFromFullRef', () => {
  it('strips refs/heads/ and trailing newline', () => {
    expect(readBranchNameFromFullRef('refs/heads/main\n')).toBe('main')
    expect(readBranchNameFromFullRef(`refs/heads/${FULL_CHINESE_BRANCH}\n`)).toBe(
      FULL_CHINESE_BRANCH
    )
  })

  it('returns null for a detached HEAD (empty output)', () => {
    expect(readBranchNameFromFullRef('')).toBeNull()
    expect(readBranchNameFromFullRef('\n')).toBeNull()
  })

  it('passes through a non-branch full ref', () => {
    expect(readBranchNameFromFullRef('refs/remotes/origin/main\n')).toBe('refs/remotes/origin/main')
  })
})

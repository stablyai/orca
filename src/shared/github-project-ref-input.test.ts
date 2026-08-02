import { describe, expect, it } from 'vitest'

import {
  GITHUB_PROJECT_REF_INPUT_MAX_BYTES,
  getGitHubProjectRefInputByteLength,
  hasBoundedGitHubProjectRefInputText,
  isGitHubProjectRefInputTooLarge
} from './github-project-ref-input'

describe('GitHub project reference input limits', () => {
  it('allows normal project references below the byte budget', () => {
    expect(
      isGitHubProjectRefInputTooLarge('https://github.com/orgs/acme/projects/42/views/3')
    ).toBe(false)
  })

  it('measures UTF-8 bytes instead of JavaScript string length', () => {
    expect(getGitHubProjectRefInputByteLength('\u00e9')).toBe(2)
  })

  it('rejects oversized pasted project references', () => {
    expect(isGitHubProjectRefInputTooLarge('x'.repeat(GITHUB_PROJECT_REF_INPUT_MAX_BYTES))).toBe(
      false
    )
    expect(
      isGitHubProjectRefInputTooLarge('x'.repeat(GITHUB_PROJECT_REF_INPUT_MAX_BYTES + 1))
    ).toBe(true)
  })

  it('rejects multibyte project references whose character count is below the limit', () => {
    const reference = '😀'.repeat(Math.floor(GITHUB_PROJECT_REF_INPUT_MAX_BYTES / 4) + 1)

    expect(reference.length).toBeLessThan(GITHUB_PROJECT_REF_INPUT_MAX_BYTES)
    expect(isGitHubProjectRefInputTooLarge(reference)).toBe(true)
  })

  it('rejects oversized whitespace before submit checks trim the reference', () => {
    const oversizedWhitespace = ' '.repeat(GITHUB_PROJECT_REF_INPUT_MAX_BYTES + 1)

    expect(isGitHubProjectRefInputTooLarge(oversizedWhitespace)).toBe(true)
    expect(hasBoundedGitHubProjectRefInputText(oversizedWhitespace)).toBe(false)
    expect(hasBoundedGitHubProjectRefInputText('  acme/42  ')).toBe(true)
    expect(hasBoundedGitHubProjectRefInputText('   ')).toBe(false)
  })
})

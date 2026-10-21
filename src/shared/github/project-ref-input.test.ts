import { describe, expect, it } from 'vitest'

import {
  GITHUB_PROJECT_REF_INPUT_MAX_BYTES,
  hasBoundedGitHubProjectRefInputText,
  isGitHubProjectRefInputTooLarge
} from './project-ref-input'

describe('GitHub project reference input limits', () => {
  it('rejects oversized whitespace before submit checks trim the reference', () => {
    const oversizedWhitespace = ' '.repeat(GITHUB_PROJECT_REF_INPUT_MAX_BYTES + 1)

    expect(isGitHubProjectRefInputTooLarge(oversizedWhitespace)).toBe(true)
    expect(hasBoundedGitHubProjectRefInputText(oversizedWhitespace)).toBe(false)
    expect(hasBoundedGitHubProjectRefInputText('  acme/42  ')).toBe(true)
    expect(hasBoundedGitHubProjectRefInputText('   ')).toBe(false)
  })
})

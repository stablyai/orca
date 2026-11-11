import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GITHUB_PR_REVIEWER_INPUT_MAX_BYTES,
  parseGitHubReviewerInputLogins
} from './pr-reviewer-display'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GitHub PR reviewer display', () => {
  it('rejects oversized reviewer input before tokenizing pasted text', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const oversized = 'secret-reviewer,'.repeat(GITHUB_PR_REVIEWER_INPUT_MAX_BYTES)

    expect(parseGitHubReviewerInputLogins(oversized)).toEqual([])
    expect(split).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { getTaskPagePerRepoLimit, taskPageToGitHubApiPage } from './work-items'

describe('numbered GitHub pagination', () => {
  it('converts zero-indexed task pages to one-indexed API pages', () => {
    expect(taskPageToGitHubApiPage(0)).toBe(1)
    expect(taskPageToGitHubApiPage(1)).toBe(2)
    expect(taskPageToGitHubApiPage(15)).toBe(16)
  })

  it('divides the display budget before per-repo fetches can overflow it', () => {
    expect(getTaskPagePerRepoLimit(1, 36, 100)).toBe(36)
    expect(getTaskPagePerRepoLimit(2, 36, 100)).toBe(36)
    expect(getTaskPagePerRepoLimit(3, 36, 100)).toBe(33)
    expect(getTaskPagePerRepoLimit(90, 36, 100)).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'

import {
  GITHUB_WORK_ITEMS_QUERY_MAX_BYTES,
  isGitHubWorkItemsQueryTooLarge
} from './github-work-items-query-bounds'

describe('shared GitHub work item query bounds', () => {
  it('allows normal GitHub search syntax', () => {
    expect(isGitHubWorkItemsQueryTooLarge('is:issue is:open label:bug')).toBe(false)
  })

  it('rejects oversized pasted work item queries by byte length', () => {
    expect(isGitHubWorkItemsQueryTooLarge('x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES))).toBe(
      false
    )
    expect(isGitHubWorkItemsQueryTooLarge('x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES + 1))).toBe(
      true
    )
  })

  it('rejects multibyte pasted queries whose character count is below the limit', () => {
    const query = '😀'.repeat(Math.floor(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES / 4) + 1)

    expect(query.length).toBeLessThan(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES)
    expect(isGitHubWorkItemsQueryTooLarge(query)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import {
  GITHUB_WORK_ITEMS_QUERY_MAX_BYTES,
  isGitHubWorkItemsQueryTooLarge
} from './github-work-items-query-bounds'

describe('GitHub work item query bounds', () => {
  it('allows normal GitHub search syntax', () => {
    expect(isGitHubWorkItemsQueryTooLarge('is:pr is:open label:bug')).toBe(false)
  })

  it('rejects oversized pasted work item queries', () => {
    expect(isGitHubWorkItemsQueryTooLarge('x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES))).toBe(
      false
    )
    expect(isGitHubWorkItemsQueryTooLarge('x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES + 1))).toBe(
      true
    )
  })

  it('measures UTF-8 bytes for non-ASCII query text', () => {
    expect(isGitHubWorkItemsQueryTooLarge(String.fromCodePoint(0x1f600).repeat(3_000))).toBe(true)
  })
})

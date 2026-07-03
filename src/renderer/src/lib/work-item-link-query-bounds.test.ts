import { describe, expect, it } from 'vitest'

import {
  WORK_ITEM_LINK_QUERY_MAX_BYTES,
  isWorkItemLinkQueryTooLarge
} from './work-item-link-query-bounds'

describe('work item link query bounds', () => {
  it('allows normal work item link queries', () => {
    expect(isWorkItemLinkQueryTooLarge('https://github.com/stablyai/orca/issues/923')).toBe(false)
  })

  it('measures UTF-8 bytes for pasted link queries', () => {
    expect(isWorkItemLinkQueryTooLarge('\u{1f600}'.repeat(600))).toBe(true)
  })

  it('rejects oversized pasted query strings', () => {
    expect(isWorkItemLinkQueryTooLarge('x'.repeat(WORK_ITEM_LINK_QUERY_MAX_BYTES))).toBe(false)
    expect(isWorkItemLinkQueryTooLarge('x'.repeat(WORK_ITEM_LINK_QUERY_MAX_BYTES + 1))).toBe(true)
  })
})

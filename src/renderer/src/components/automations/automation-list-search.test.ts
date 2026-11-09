import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS,
  AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES,
  automationListSearchIndexMatches,
  buildAutomationListSearchIndex,
  clampAutomationListSearchQueryInput,
  isAutomationListSearchQueryTooLarge,
  resolveAutomationListSearchQuery,
  truncateAutomationListSearchField
} from './automation-list-search'

describe('automation-list-search', () => {
  it('rejects queries over the byte limit but under the code-unit limit', () => {
    // 3 UTF-8 bytes per character, so half the cap in code units is over it in bytes.
    const multiByte = '한'.repeat(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES / 2)
    expect(multiByte.length).toBeLessThanOrEqual(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES)
    expect(isAutomationListSearchQueryTooLarge(multiByte)).toBe(true)
    expect(resolveAutomationListSearchQuery(multiByte)).toEqual({ status: 'too_large' })
  })

  it('clamps stored query input so multi-MB pastes are discarded', () => {
    const hugePaste = 'a'.repeat(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES * 100)
    const clamped = clampAutomationListSearchQueryInput(hugePaste)
    expect(clamped.length).toBe(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES + 1)
    expect(isAutomationListSearchQueryTooLarge(clamped)).toBe(true)
    expect(clampAutomationListSearchQueryInput('auto pr')).toBe('auto pr')
  })

  it('caps indexed field length so huge prompts stay bounded', () => {
    const prompt = `${'x'.repeat(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS)}unique-tail-token`
    const index = buildAutomationListSearchIndex({
      name: 'Nightly',
      project: 'mobile',
      prompt
    })
    expect(index.prompt.length).toBe(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS)
    expect(automationListSearchIndexMatches(index, 'unique-tail-token')).toBe(false)
    expect(automationListSearchIndexMatches(index, 'xxxx')).toBe(true)
  })

  it('does not split surrogate pairs when truncating', () => {
    const emoji = '😀'
    const value = `${'a'.repeat(7)}${emoji}`
    expect(truncateAutomationListSearchField(value, 8)).toBe('a'.repeat(7))
    expect(truncateAutomationListSearchField(value, 9)).toBe(value)
  })
})

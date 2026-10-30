import { describe, expect, it } from 'vitest'
import {
  PULL_REQUEST_PICKER_QUERY_MAX_BYTES,
  filterPullRequestPickerOptions,
  getPullRequestPickerQueryState,
  type PickerOption
} from './PRFilterPickers'

describe('filterPullRequestPickerOptions', () => {
  const options: PickerOption[] = [
    { key: 'alice', primary: 'alice', secondary: 'Alice Smith' },
    { key: 'bug', primary: 'bug' },
    { key: 'docs', primary: 'documentation' }
  ]

  it('rejects oversized pasted queries before reading picker option text', () => {
    const oversizedQuery = 'secret-pr-picker-filter'.repeat(PULL_REQUEST_PICKER_QUERY_MAX_BYTES)
    const throwingOptions = [
      {
        key: 'secret',
        get primary(): string {
          throw new Error('oversized PR picker filters must not scan primary text')
        },
        get secondary(): string {
          throw new Error('oversized PR picker filters must not scan secondary text')
        }
      }
    ]

    expect(filterPullRequestPickerOptions(throwingOptions, oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming picker filters', () => {
    const oversizedWhitespace = ' '.repeat(PULL_REQUEST_PICKER_QUERY_MAX_BYTES + 1)

    expect(getPullRequestPickerQueryState(oversizedWhitespace)).toEqual({
      queryTooLarge: true,
      trimmedQuery: ''
    })
    expect(filterPullRequestPickerOptions(options, oversizedWhitespace)).toEqual([])
  })
})

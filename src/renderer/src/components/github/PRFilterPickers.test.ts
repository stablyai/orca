import { describe, expect, it } from 'vitest'
import {
  PULL_REQUEST_PICKER_QUERY_MAX_BYTES,
  filterPullRequestPickerOptions
} from './PRFilterPickers'

describe('filterPullRequestPickerOptions', () => {
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
})

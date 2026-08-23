import { describe, expect, it } from 'vitest'
import {
  TASK_PICKER_QUERY_MAX_BYTES,
  filterTaskPickerOptions,
  getTaskPickerQueryState,
  isTaskPickerQueryTooLarge,
  type PickerOption
} from './task-filter-pickers'

describe('filterTaskPickerOptions', () => {
  const options: PickerOption[] = [
    { key: 'alice', primary: 'alice', secondary: 'Alice Smith' },
    { key: 'bug', primary: 'bug' },
    { key: 'docs', primary: 'documentation' }
  ]

  it('returns all options for empty queries', () => {
    expect(filterTaskPickerOptions(options, '')).toEqual(options)
    expect(filterTaskPickerOptions(options, '   ')).toEqual(options)
  })

  it('matches primary and secondary text case-insensitively', () => {
    expect(filterTaskPickerOptions(options, 'BUG')).toEqual([options[1]])
    expect(filterTaskPickerOptions(options, 'smith')).toEqual([options[0]])
  })

  it('rejects oversized pasted queries before reading picker option text', () => {
    const oversizedQuery = 'secret-picker-filter'.repeat(TASK_PICKER_QUERY_MAX_BYTES)
    const throwingOptions = [
      {
        key: 'secret',
        get primary(): string {
          throw new Error('oversized picker filters must not scan primary text')
        },
        get secondary(): string {
          throw new Error('oversized picker filters must not scan secondary text')
        }
      }
    ]

    expect(isTaskPickerQueryTooLarge(oversizedQuery)).toBe(true)
    expect(filterTaskPickerOptions(throwingOptions, oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming picker filters', () => {
    const oversizedWhitespace = ' '.repeat(TASK_PICKER_QUERY_MAX_BYTES + 1)

    expect(getTaskPickerQueryState(oversizedWhitespace)).toEqual({
      queryTooLarge: true,
      trimmedQuery: ''
    })
    expect(filterTaskPickerOptions(options, oversizedWhitespace)).toEqual([])
  })
})

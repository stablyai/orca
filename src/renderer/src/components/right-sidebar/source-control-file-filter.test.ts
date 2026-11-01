import { describe, expect, it } from 'vitest'
import {
  SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES,
  filterSourceControlPathEntries,
  getSourceControlFileFilterState,
  isSourceControlFileFilterQueryTooLarge,
  type SourceControlPathEntry
} from './source-control/listing/file-filter'

describe('source-control-file-filter', () => {
  it('rejects oversized filters before reading entry paths', () => {
    const oversizedQuery = 'secret-source-control'.repeat(
      SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES
    )
    const throwingEntry: SourceControlPathEntry = {
      get path(): string {
        throw new Error('oversized filters must not scan source-control paths')
      }
    }
    const filter = getSourceControlFileFilterState(oversizedQuery)

    expect(isSourceControlFileFilterQueryTooLarge(oversizedQuery)).toBe(true)
    expect(filter).toEqual({ normalizedFilter: '', tooLarge: true })
    expect(filterSourceControlPathEntries([throwingEntry], filter)).toEqual([])
  })

  it('rejects oversized whitespace before trimming source-control filters', () => {
    expect(
      getSourceControlFileFilterState(' '.repeat(SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES + 1))
    ).toEqual({ normalizedFilter: '', tooLarge: true })
  })
})

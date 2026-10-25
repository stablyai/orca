import { describe, expect, it } from 'vitest'
import {
  SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES,
  filterSourceControlPathEntries,
  getSourceControlFileFilterState,
  isSourceControlFileFilterQueryTooLarge,
  type SourceControlPathEntry
} from './source-control/listing/file-filter'

describe('source-control-file-filter', () => {
  it('normalizes bounded queries and filters entries by path', () => {
    const filter = getSourceControlFileFilterState('  SRC/button  ')

    expect(filter).toEqual({ normalizedFilter: 'src/button', tooLarge: false })
    expect(
      filterSourceControlPathEntries(
        [{ path: 'src/Button.tsx' }, { path: 'docs/Button.md' }],
        filter
      )
    ).toEqual([{ path: 'src/Button.tsx' }])
  })

  it('returns the original entries for empty filters', () => {
    const entries = [{ path: 'src/a.ts' }]

    expect(filterSourceControlPathEntries(entries, getSourceControlFileFilterState(' '))).toBe(
      entries
    )
  })

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

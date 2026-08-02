import { describe, expect, it } from 'vitest'
import {
  SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES,
  filterSourceControlGroupedPathEntries,
  filterSourceControlPathEntries,
  getSourceControlFileFilterState,
  isSourceControlFileFilterQueryTooLarge,
  type SourceControlPathEntry
} from './source-control-file-filter'

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

  it('returns original entry groups for empty filters', () => {
    const grouped = {
      staged: [{ path: 'src/a.ts' }],
      unstaged: [{ path: 'src/b.ts' }],
      untracked: [{ path: 'src/c.ts' }]
    }

    expect(
      filterSourceControlGroupedPathEntries(grouped, getSourceControlFileFilterState(' '))
    ).toBe(grouped)
  })

  it('rejects oversized filters before reading entry paths', () => {
    const oversizedQuery = 'secret-source-control'.repeat(
      SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES
    )
    const throwingEntry = {
      get path(): string {
        throw new Error('oversized filters must not scan source-control paths')
      }
    } as SourceControlPathEntry
    const filter = getSourceControlFileFilterState(oversizedQuery)

    expect(isSourceControlFileFilterQueryTooLarge(oversizedQuery)).toBe(true)
    expect(filter).toEqual({ normalizedFilter: '', tooLarge: true })
    expect(filterSourceControlPathEntries([throwingEntry], filter)).toEqual([])
    expect(
      filterSourceControlGroupedPathEntries(
        { staged: [throwingEntry], unstaged: [throwingEntry], untracked: [throwingEntry] },
        filter
      )
    ).toEqual({ staged: [], unstaged: [], untracked: [] })
  })

  it('rejects oversized whitespace before trimming source-control filters', () => {
    expect(
      getSourceControlFileFilterState(' '.repeat(SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES + 1))
    ).toEqual({ normalizedFilter: '', tooLarge: true })
  })
})

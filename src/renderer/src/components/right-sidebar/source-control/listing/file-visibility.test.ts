import { describe, expect, it } from 'vitest'
import { filterSourceControlPathEntries, getSourceControlFileFilterState } from './file-filter'
import {
  createSourceControlFileVisibilityFilter,
  getSourceControlExtensionCounts,
  getSourceControlFileExtension
} from './file-visibility'

describe('source control file visibility', () => {
  it.each([
    ['src/example.test.ts', '.ts'],
    ['.gitignore', ''],
    ['folder.name/README', ''],
    ['file.', ''],
    ['.env.local', '.local'],
    ['src/UPPER.TS', '.TS']
  ])('classifies the final path component of %s', (path, extension) => {
    expect(getSourceControlFileExtension(path)).toBe(extension)
  })

  it('counts unique paths across staging areas and includes extensionless files', () => {
    expect(getSourceControlExtensionCounts(['a.ts', 'a.ts', 'b.ts', 'a.tsx', 'README'])).toEqual([
      { extension: '', count: 1 },
      { extension: '.ts', count: 2 },
      { extension: '.tsx', count: 1 }
    ])
  })

  it('combines text, extension, and named groups with gitignore negation', () => {
    const entries = [
      'src/a.ts',
      'src/b.md',
      'src/a.generated.ts',
      'src/keep.generated.ts',
      'src/__snapshots__/a.ts',
      'test/a.ts'
    ].map((path) => ({ path }))
    const includesEntry = createSourceControlFileVisibilityFilter(new Set(['.md']), [
      { name: 'Snapshots', patterns: ['**/__snapshots__/**'] },
      { name: 'Generated', patterns: ['**/*.generated.ts', '!src/keep.generated.ts'] }
    ])
    expect(
      filterSourceControlPathEntries(
        entries,
        getSourceControlFileFilterState('src/', includesEntry)
      )
    ).toEqual([{ path: 'src/a.ts' }, { path: 'src/keep.generated.ts' }])
    expect(entries).toHaveLength(6)
  })

  it('keeps negation scoped to its group and respects root-anchored patterns', () => {
    const includesEntry = createSourceControlFileVisibilityFilter(new Set(), [
      { name: 'Root snapshots', patterns: ['/*.snap', '!keep.snap'] },
      { name: 'Keep', patterns: ['keep.snap'] }
    ])
    expect(
      filterSourceControlPathEntries(
        ['root.snap', 'nested/root.snap', 'keep.snap'].map((path) => ({ path })),
        getSourceControlFileFilterState('', includesEntry)
      )
    ).toEqual([{ path: 'nested/root.snap' }])
  })

  it('matches groups case-sensitively even when the desktop host differs from SSH', () => {
    const includesEntry = createSourceControlFileVisibilityFilter(new Set(), [
      { name: 'Generated', patterns: ['generated/**'] }
    ])
    expect(
      filterSourceControlPathEntries(
        [{ path: 'generated/a.ts' }, { path: 'Generated/a.ts' }],
        getSourceControlFileFilterState('', includesEntry)
      )
    ).toEqual([{ path: 'Generated/a.ts' }])
  })

  it('preserves identity when nothing is selected', () => {
    expect(createSourceControlFileVisibilityFilter(new Set(), [])).toBeUndefined()
  })
})

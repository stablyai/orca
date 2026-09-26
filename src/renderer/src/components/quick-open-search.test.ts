import { describe, expect, it } from 'vitest'
import {
  QuickOpenPathRanker,
  QUICK_OPEN_QUERY_MAX_BYTES,
  QUICK_OPEN_RESULT_LIMIT,
  isQuickOpenQueryTooLarge,
  prepareQuickOpenFiles,
  rankQuickOpenFiles,
  type QuickOpenIndexedFile
} from './quick-open-search'

describe('quick-open-search', () => {
  it('finds and retains a target after 100k non-matches without retaining the inventory', () => {
    const ranker = new QuickOpenPathRanker('sta-4354-tail-target', 32)
    for (let index = 0; index < 100_100; index++) {
      ranker.consider(`data/chunk-${String(index).padStart(6, '0')}/payload.bin`)
    }
    ranker.consider('src/sta-4354-tail-target.ts')

    expect(ranker.result()).toEqual({
      paths: ['src/sta-4354-tail-target.ts'],
      totalCount: 1
    })
  })
  it('orders numbered paths naturally for empty queries and fuzzy-score ties', () => {
    const files = prepareQuickOpenFiles([
      'songs/100 - b.txt',
      'songs/9 - c.txt',
      'songs/99 - a.txt'
    ])

    expect(rankQuickOpenFiles('', files).map((item) => item.path)).toEqual([
      'songs/9 - c.txt',
      'songs/99 - a.txt',
      'songs/100 - b.txt'
    ])
    expect(rankQuickOpenFiles('songs', files).map((item) => item.path)).toEqual([
      'songs/9 - c.txt',
      'songs/99 - a.txt',
      'songs/100 - b.txt'
    ])
  })

  it('returns the first 50 naturally sorted paths with score 0 for an empty query', () => {
    const files = Array.from({ length: 75 }, (_, index) => `src/file-${74 - index}.ts`)

    expect(rankQuickOpenFiles('', prepareQuickOpenFiles(files))).toEqual(
      Array.from({ length: QUICK_OPEN_RESULT_LIMIT }, (_, index) => ({
        path: `src/file-${index}.ts`,
        score: 0
      }))
    )
  })

  it('treats a whitespace-only query as empty', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts']

    expect(rankQuickOpenFiles('   ', prepareQuickOpenFiles(files))).toEqual([
      { path: 'src/a.ts', score: 0 },
      { path: 'src/b.ts', score: 0 },
      { path: 'src/c.ts', score: 0 }
    ])
  })

  it('prefers filename substring matches over path-only matches', () => {
    const files = ['button-area/deep/path/file.tsx', 'src/components/Button.tsx']

    expect(
      rankQuickOpenFiles('button', prepareQuickOpenFiles(files)).map((item) => item.path)
    ).toEqual(['src/components/Button.tsx', 'button-area/deep/path/file.tsx'])
  })

  it('matches every whitespace-separated term regardless of term order', () => {
    const files = prepareQuickOpenFiles(['apps/web/.env', 'apps/api/.env', 'packages/shared/.env'])

    expect(rankQuickOpenFiles('.env api', files).map((item) => item.path)).toEqual([
      'apps/api/.env'
    ])
    expect(rankQuickOpenFiles('api .env', files).map((item) => item.path)).toEqual([
      'apps/api/.env'
    ])
  })

  it('deduplicates terms separated by mixed whitespace', () => {
    const files = prepareQuickOpenFiles(['apps/api/.env', 'services/api/.env.local'])

    expect(rankQuickOpenFiles('\t.env\napi api  ', files)).toEqual(
      rankQuickOpenFiles('.env api', files)
    )
  })

  it('keeps matches whose combined term score is negative one', () => {
    const files = prepareQuickOpenFiles(['a1234b/c/file.ts'])

    expect(rankQuickOpenFiles('ab c', files)).toEqual([{ path: 'a1234b/c/file.ts', score: -1 }])
  })

  it('keeps multi-term matches when an individual term scores negative one', () => {
    const files = prepareQuickOpenFiles(['a123/b/c/file.ts'])

    expect(rankQuickOpenFiles('ab c', files)).toEqual([{ path: 'a123/b/c/file.ts', score: -6 }])
  })

  it('preserves the single-term negative-one exclusion', () => {
    const files = prepareQuickOpenFiles(['a123/b/file.ts'])

    expect(rankQuickOpenFiles('ab', files)).toEqual([])
  })

  it('uses natural order for tie-heavy results at the limit boundary', () => {
    const files = Array.from({ length: 10 }, (_, index) => `src/path-${9 - index}.bin`)

    expect(rankQuickOpenFiles('s', prepareQuickOpenFiles(files), 4)).toEqual([
      { path: 'src/path-0.bin', score: 0 },
      { path: 'src/path-1.bin', score: 0 },
      { path: 'src/path-2.bin', score: 0 },
      { path: 'src/path-3.bin', score: 0 }
    ])
  })

  it('returns 50 top-ranked results from a 100k synthetic list', () => {
    const fillerCount = 99_940
    const topCandidateCount = 60
    const files = [
      ...Array.from(
        { length: fillerCount },
        (_, index) => `n-x-e-x-e-x-d-x-l-x-e/group-${index}/file.ts`
      ),
      ...Array.from({ length: topCandidateCount }, (_, index) => `bulk/special-${index}/needle.ts`)
    ]

    const results = rankQuickOpenFiles('needle', prepareQuickOpenFiles(files))

    expect(results).toHaveLength(QUICK_OPEN_RESULT_LIMIT)
    expect(results.map((item) => item.path)).toEqual(
      Array.from(
        { length: QUICK_OPEN_RESULT_LIMIT },
        (_, index) => `bulk/special-${index}/needle.ts`
      )
    )
  })

  it('returns 50 top-ranked multi-term results from a 100k synthetic list', () => {
    const fillerCount = 99_940
    const topCandidateCount = 60
    const files = [
      ...Array.from(
        { length: fillerCount },
        (_, index) => `n-x-e-x-e-x-d-x-l-x-e/group-${index}/file.ts`
      ),
      ...Array.from({ length: topCandidateCount }, (_, index) => `bulk/special-${index}/needle.ts`)
    ]

    const results = rankQuickOpenFiles('needle special', prepareQuickOpenFiles(files))

    expect(results).toHaveLength(QUICK_OPEN_RESULT_LIMIT)
    expect(results.map((item) => item.path)).toEqual(
      Array.from(
        { length: QUICK_OPEN_RESULT_LIMIT },
        (_, index) => `bulk/special-${index}/needle.ts`
      )
    )
  })

  it('ranks multi-term matches through the streaming path used on remote hosts', () => {
    const ranker = new QuickOpenPathRanker('.env api', 8)
    for (const path of ['apps/web/.env', 'apps/api/.env', 'packages/shared/.env']) {
      ranker.consider(path)
    }

    expect(ranker.result()).toEqual({
      paths: ['apps/api/.env'],
      totalCount: 1
    })
  })

  it('skips streamed paths for oversized or excessive-term queries', () => {
    const oversized = new QuickOpenPathRanker(
      'secret-quick-open'.repeat(QUICK_OPEN_QUERY_MAX_BYTES),
      8
    )
    oversized.consider('src/secret.ts')
    expect(oversized.result()).toEqual({ paths: [], totalCount: 0 })

    const excessive = new QuickOpenPathRanker(
      Array.from({ length: 33 }, (_, index) => `term-${index}`).join(' '),
      8
    )
    excessive.consider('src/file.ts')
    expect(excessive.result()).toEqual({ paths: [], totalCount: 0 })
  })

  it('returns scores sorted ascending', () => {
    const files = [
      'src/components/QuickOpen.tsx',
      'quick/open/deep/path/file.tsx',
      'src/q-u-i-c-k-open.ts'
    ]

    const scores = rankQuickOpenFiles('quick', prepareQuickOpenFiles(files)).map(
      (item) => item.score
    )

    expect(scores).toEqual([...scores].sort((a, b) => a - b))
  })

  it('indexes normalized relative paths without changing path semantics', () => {
    const files = [
      'src/renderer/src/components/QuickOpen.tsx',
      'legacy\\provider\\raw-path.ts',
      'packages/windows-origin/src/App.tsx',
      'single-file.ts'
    ]

    expect(prepareQuickOpenFiles(files)).toEqual([
      {
        path: 'src/renderer/src/components/QuickOpen.tsx',
        lowerPath: 'src/renderer/src/components/quickopen.tsx',
        lowerFilename: 'quickopen.tsx',
        inputIndex: 0
      },
      {
        path: 'legacy\\provider\\raw-path.ts',
        lowerPath: 'legacy/provider/raw-path.ts',
        lowerFilename: 'raw-path.ts',
        inputIndex: 1
      },
      {
        path: 'packages/windows-origin/src/App.tsx',
        lowerPath: 'packages/windows-origin/src/app.tsx',
        lowerFilename: 'app.tsx',
        inputIndex: 2
      },
      {
        path: 'single-file.ts',
        lowerPath: 'single-file.ts',
        lowerFilename: 'single-file.ts',
        inputIndex: 3
      }
    ])
  })

  it('returns no results for non-positive limits', () => {
    const files = prepareQuickOpenFiles(['src/a.ts'])

    expect(rankQuickOpenFiles('a', files, 0)).toEqual([])
    expect(rankQuickOpenFiles('a', files, -1)).toEqual([])
  })

  it('rejects oversized pasted queries before reading indexed file candidates', () => {
    const oversizedQuery = 'secret-quick-open'.repeat(QUICK_OPEN_QUERY_MAX_BYTES)
    const file = {
      path: 'src/secret.ts',
      inputIndex: 0,
      get lowerPath(): string {
        throw new Error('oversized queries must not scan indexed paths')
      },
      get lowerFilename(): string {
        throw new Error('oversized queries must not scan indexed filenames')
      }
    } as QuickOpenIndexedFile

    expect(isQuickOpenQueryTooLarge(oversizedQuery)).toBe(true)
    expect(rankQuickOpenFiles(oversizedQuery, [file])).toEqual([])
  })

  it('rejects oversized whitespace before trimming quick-open queries', () => {
    expect(
      rankQuickOpenFiles(
        ' '.repeat(QUICK_OPEN_QUERY_MAX_BYTES + 1),
        prepareQuickOpenFiles(['src/a.ts'])
      )
    ).toEqual([])
  })

  it('rejects queries with more than 32 unique terms', () => {
    const terms = Array.from({ length: 33 }, (_, index) => `term-${index}`)
    const file = {
      path: terms.join('/'),
      inputIndex: 0,
      get lowerPath(): string {
        throw new Error('excessive terms must not scan indexed paths')
      },
      get lowerFilename(): string {
        throw new Error('excessive terms must not scan indexed filenames')
      }
    } as QuickOpenIndexedFile

    expect(rankQuickOpenFiles(terms.join(' '), [file])).toEqual([])
  })

  it('matches Windows-style path queries against slash-normalized file paths', () => {
    const files = prepareQuickOpenFiles([
      'src/components/Button.tsx',
      'src/components/ButtonGroup.tsx',
      'src/routes/About.tsx'
    ])

    expect(rankQuickOpenFiles('src\\components\\button', files).map((item) => item.path)).toEqual([
      'src/components/Button.tsx',
      'src/components/ButtonGroup.tsx'
    ])
  })
})

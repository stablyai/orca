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

it('matches independent unique terms in either order in streaming and indexed searches', () => {
  const paths = ['apps/api/.env', 'apps/web/.env', 'apps/api/server.ts']
  const indexed = prepareQuickOpenFiles(paths)
  const expected = rankQuickOpenFiles('.env api', indexed)
  expect(expected.map((item) => item.path)).toEqual(['apps/api/.env'])
  for (const query of ['api .env', '  API\t.env\napi  ']) {
    expect(rankQuickOpenFiles(query, indexed)).toEqual(expected)
    const ranker = new QuickOpenPathRanker(query, 50)
    paths.forEach((path) => ranker.consider(path))
    expect(ranker.result()).toEqual({ paths: ['apps/api/.env'], totalCount: 1 })
  }
})

it('preserves every term in valid queries beyond 32 unique terms', () => {
  const terms = Array.from({ length: 33 }, (_, i) => `a${i}`)
  const path = `${terms.join('-')}.ts`
  const query = terms.join(' ')
  expect(query.length).toBe(121)
  expect(path.length).toBe(124)
  const indexed = prepareQuickOpenFiles([path, 'a0.ts'])
  expect(rankQuickOpenFiles(query, indexed).map((item) => item.path)).toEqual([path])
  const ranker = new QuickOpenPathRanker(query, 50)
  ranker.consider(path)
  expect(ranker.result().paths).toEqual([path])
  expect(rankQuickOpenFiles(`${query} missing`, indexed)).toEqual([])
  expect(rankQuickOpenFiles(Array(40).fill('a').join(' '), indexed)).toEqual(
    rankQuickOpenFiles('a', indexed)
  )
})

it.each([
  ['user-profile', 'user/UserProfile/index.tsx'],
  ['user-profile', 'user/UserProfile/components/views/index.tsx'],
  ['product_detail', 'product/ProductDetail.ts'],
  ['tab_bar_create_entry', 'tab-bar/TabBarCreateEntry.tsx'],
  ['tab_bar_create_entry', 'tab-bar/TabBarCreateEntry/components/views/index.tsx']
])('reconsiders separator alternatives for %s beneath an ancestor', (query, path) => {
  expect(rankQuickOpenFiles(query, prepareQuickOpenFiles([path])).map((item) => item.path)).toEqual(
    [path]
  )
  const ranker = new QuickOpenPathRanker(query, 50)
  ranker.consider(path)
  expect(ranker.result().paths).toEqual([path])
})

it('matches separator variants while preferring the separator typed', () => {
  const paths = prepareQuickOpenFiles([
    'src/product_detail.ts',
    'src/product-detail.ts',
    'src/ProductDetail.ts'
  ])
  expect(rankQuickOpenFiles('product-detail', paths).map((item) => item.path)).toEqual([
    'src/product-detail.ts',
    'src/product_detail.ts',
    'src/ProductDetail.ts'
  ])
  expect(rankQuickOpenFiles('product_detail', paths).map((item) => item.path)).toEqual([
    'src/product_detail.ts',
    'src/product-detail.ts',
    'src/ProductDetail.ts'
  ])
  expect(rankQuickOpenFiles('product detail', paths).map((item) => item.path)).toHaveLength(3)
})

it('retains legitimate negative-one scores', () => {
  expect(rankQuickOpenFiles('ab', prepareQuickOpenFiles(['x/a1234b.txt']))).toEqual([
    { path: 'x/a1234b.txt', score: -1 }
  ])
})

it('bridges camel and acronym word boundaries for typed separators without matching flat words', () => {
  const files = prepareQuickOpenFiles([
    'src/ProductDetail.ts',
    'src/productdetail.ts',
    'src/HTTPServer.ts',
    'src/Product Detail.ts'
  ])
  expect(
    rankQuickOpenFiles('product_detail', files)
      .map((item) => item.path)
      .sort()
  ).toEqual(['src/Product Detail.ts', 'src/ProductDetail.ts'])
  expect(rankQuickOpenFiles('http-server', files).map((item) => item.path)).toEqual([
    'src/HTTPServer.ts'
  ])
  expect(rankQuickOpenFiles('product-', files).map((item) => item.path)).toContain(
    'src/ProductDetail.ts'
  )
})

it('evaluates all terms up to the existing byte limit and rejects only oversized input', () => {
  const terms = Array.from({ length: 350 }, (_, i) => `t${i}`)
  const query = terms.join(' ')
  const path = `${terms.join('/')}.ts`
  expect(query.length).toBeLessThan(2048)
  expect(rankQuickOpenFiles(query, prepareQuickOpenFiles([path])).map((item) => item.path)).toEqual(
    [path]
  )
  expect(rankQuickOpenFiles(`${query} absent`, prepareQuickOpenFiles([path]))).toEqual([])
  expect(rankQuickOpenFiles(`${query}${' '.repeat(2048)}`, prepareQuickOpenFiles([path]))).toEqual(
    []
  )
})

it.each([
  ['abc-', 'abc.ts'],
  ['bar-', 'foo-bar.ts'],
  ['product_', 'productdetail.ts']
])('requires a boundary after a trailing separator in %s', (query, path) => {
  expect(rankQuickOpenFiles(query, prepareQuickOpenFiles([path]))).toEqual([])
})

it.each([
  ['abc-', 'abc-file.ts'],
  ['product_', 'ProductDetail.ts'],
  ['http-', 'HTTPServer.ts']
])('retains real trailing separator boundaries for %s', (query, path) => {
  expect(rankQuickOpenFiles(query, prepareQuickOpenFiles([path]))).toHaveLength(1)
})

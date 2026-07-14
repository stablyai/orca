import { describe, expect, it } from 'vitest'
import {
  QUICK_OPEN_QUERY_MAX_BYTES,
  QUICK_OPEN_RESULT_LIMIT,
  isQuickOpenQueryTooLarge,
  prepareQuickOpenFiles,
  rankQuickOpenFiles,
  type QuickOpenIndexedFile
} from './quick-open-search'

describe('quick-open-search', () => {
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

    const indexed = prepareQuickOpenFiles(files)
    expect(indexed).toMatchObject([
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

    // Why: camelCase "QuickOpen" / "App" must keep word starts after lowercasing.
    const quickOpen = 'src/renderer/src/components/QuickOpen.tsx'
    const quickOpenStarts = Array.from(indexed[0].wordStarts)
    expect(quickOpenStarts[0]).toBe(1)
    expect(quickOpenStarts[quickOpen.indexOf('Q')]).toBe(1)
    expect(quickOpenStarts[quickOpen.indexOf('O')]).toBe(1)
    expect(quickOpenStarts[quickOpen.indexOf('u')]).toBe(0)

    const appPath = 'packages/windows-origin/src/App.tsx'
    expect(indexed[1].wordStarts[appPath.indexOf('A')]).toBe(1)
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
      },
      get wordStarts(): Uint8Array {
        throw new Error('oversized queries must not scan word starts')
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

  it('matches spaced human queries to snake_case basenames like VS Code', () => {
    const files = prepareQuickOpenFiles([
      'lib/screens/product_detail.dart',
      'lib/screens/product_list.dart',
      'lib/models/order_summary.dart',
      'docs/unrelated.txt'
    ])

    const paths = rankQuickOpenFiles('Product Detail', files).map((item) => item.path)
    expect(paths).toContain('lib/screens/product_detail.dart')
    expect(paths[0]).toBe('lib/screens/product_detail.dart')
  })

  it('matches spaced queries across kebab-case, snake_case, and camelCase names', () => {
    const files = prepareQuickOpenFiles([
      'ui/product-detail.tsx',
      'ui/product_detail.tsx',
      'ui/ProductDetail.tsx',
      'ui/cart.tsx'
    ])

    const paths = rankQuickOpenFiles('product detail', files).map((item) => item.path)
    expect(paths).toEqual([
      'ui/product-detail.tsx',
      'ui/product_detail.tsx',
      'ui/ProductDetail.tsx'
    ])
  })

  it('matches spaced and identifier-separated queries to PascalCase names', () => {
    const files = prepareQuickOpenFiles(['ui/ProductDetail.tsx', 'ui/OrderDetail.tsx'])

    for (const query of ['product detail', 'product-detail', 'product_detail']) {
      expect(rankQuickOpenFiles(query, files).map((item) => item.path)).toEqual([
        'ui/ProductDetail.tsx'
      ])
    }
  })

  it('gives PascalCase filenames the same boost for spaced and separator queries', () => {
    const files = prepareQuickOpenFiles([
      'archive/old-product-detail-backup.txt',
      'ui/ProductDetail.tsx'
    ])

    for (const query of ['product detail', 'product-detail', 'product_detail']) {
      const results = rankQuickOpenFiles(query, files)
      expect(results.map((item) => item.path)).toEqual([
        'archive/old-product-detail-backup.txt',
        'ui/ProductDetail.tsx'
      ])
      // Why: without boost parity the camelCase file trailed by ~100 points
      // for `-`/`_` queries while staying competitive for spaced ones.
      expect(results[1].score).toBeLessThan(-100)
    }
  })

  it('keeps camelCase matches while typing a trailing separator', () => {
    const files = prepareQuickOpenFiles(['lib/product-x.ts', 'ui/ProductDetail.tsx'])

    expect(rankQuickOpenFiles('product-', files).map((item) => item.path)).toEqual([
      'lib/product-x.ts',
      'ui/ProductDetail.tsx'
    ])
    expect(rankQuickOpenFiles('product_', files).map((item) => item.path)).toEqual([
      'lib/product-x.ts',
      'ui/ProductDetail.tsx'
    ])
  })

  it('requires a literal separator for leading separator queries', () => {
    const files = prepareQuickOpenFiles(['ui/ProductDetail.tsx', 'ui/-detail.tsx'])

    expect(rankQuickOpenFiles('-detail', files).map((item) => item.path)).toEqual([
      'ui/-detail.tsx'
    ])
  })

  it('treats hyphens and underscores as interchangeable identifier separators', () => {
    const variants = prepareQuickOpenFiles([
      'lib/product-detail.dart',
      'lib/product_detail.dart',
      'lib/ProductDetail.tsx',
      'lib/order_detail.dart'
    ])

    expect(rankQuickOpenFiles('product-detail', variants).map((item) => item.path)).toEqual([
      'lib/product-detail.dart',
      'lib/product_detail.dart',
      'lib/ProductDetail.tsx'
    ])
    expect(rankQuickOpenFiles('product_detail', variants).map((item) => item.path)).toEqual([
      'lib/product_detail.dart',
      'lib/product-detail.dart',
      'lib/ProductDetail.tsx'
    ])
  })

  it('keeps path and extension separators distinct from identifier separators', () => {
    const files = prepareQuickOpenFiles([
      'lib/product/detail.dart',
      'lib/product.detail.dart',
      'lib/product_detail.dart'
    ])

    expect(rankQuickOpenFiles('product-detail', files).map((item) => item.path)).toEqual([
      'lib/product_detail.dart'
    ])
  })

  it('recognizes capitalized words after uppercase acronym runs', () => {
    const files = prepareQuickOpenFiles(['src/APIClient.ts', 'src/HTTPServer.ts'])

    expect(rankQuickOpenFiles('api client', files).map((item) => item.path)).toEqual([
      'src/APIClient.ts'
    ])
    expect(rankQuickOpenFiles('http server', files).map((item) => item.path)).toEqual([
      'src/HTTPServer.ts'
    ])
  })

  it('keeps word starts aligned when Unicode lowercasing expands a character', () => {
    const files = prepareQuickOpenFiles(['İ/FooBar.ts'])

    expect(files[0].lowerPath).toBe('i̇/foobar.ts')
    expect(files[0].wordStarts[files[0].lowerPath.indexOf('b')]).toBe(1)
    expect(rankQuickOpenFiles('foo bar', files).map((item) => item.path)).toEqual(['İ/FooBar.ts'])
  })

  it('matches spaced path segments to directory separators', () => {
    const files = prepareQuickOpenFiles([
      'src/components/Button.tsx',
      'src/routes/About.tsx',
      'packages/other/Button.tsx'
    ])

    expect(rankQuickOpenFiles('src components button', files).map((item) => item.path)).toEqual([
      'src/components/Button.tsx'
    ])
  })

  it('matches partial tokens with spaces (prod det → product_detail)', () => {
    const files = prepareQuickOpenFiles([
      'lib/product_detail.dart',
      'lib/production_settings.dart',
      'lib/profile.dart'
    ])

    const paths = rankQuickOpenFiles('prod det', files).map((item) => item.path)
    expect(paths).toContain('lib/product_detail.dart')
    expect(paths[0]).toBe('lib/product_detail.dart')
  })

  it('collapses internal whitespace in queries', () => {
    const files = prepareQuickOpenFiles(['lib/product_detail.dart'])

    expect(rankQuickOpenFiles('Product   Detail', files).map((item) => item.path)).toEqual([
      'lib/product_detail.dart'
    ])
  })

  it('still matches continuous snake_case queries without spaces', () => {
    const files = prepareQuickOpenFiles(['lib/product_detail.dart', 'lib/product_list.dart'])

    expect(rankQuickOpenFiles('product_detail', files).map((item) => item.path)).toEqual([
      'lib/product_detail.dart'
    ])
  })

  it('does not confuse a valid negative-one score with no match', () => {
    expect(rankQuickOpenFiles('ab', prepareQuickOpenFiles(['axxx_b/file.txt']))).toEqual([
      { path: 'axxx_b/file.txt', score: -1 }
    ])
  })
})

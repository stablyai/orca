import { describe, expect, it } from 'vitest'
import {
  QuickOpenPathRanker,
  prepareQuickOpenFiles,
  rankQuickOpenFiles
} from '../../../shared/quick-open/quick-open-path-search'

describe('quick-open-search', () => {
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

it('matches a composed query against a path stored in decomposed Unicode form', () => {
  // macOS often stores Hangul names decomposed (NFD); keyboards type them composed (NFC).
  const decomposedPath = 'docs/\u1112\u1161\u11ab\u1100\u1173\u11af.md'

  expect(
    rankQuickOpenFiles('\ud55c\uae00', prepareQuickOpenFiles([decomposedPath])).map(
      (item) => item.path
    )
  ).toEqual([decomposedPath])
})

it('matches a decomposed query against a path stored in composed Unicode form', () => {
  const composedPath = 'docs/\ud55c\uae00.md'

  expect(
    rankQuickOpenFiles(
      '\u1112\u1161\u11ab\u1100\u1173\u11af',
      prepareQuickOpenFiles([composedPath])
    ).map((item) => item.path)
  ).toEqual([composedPath])
})

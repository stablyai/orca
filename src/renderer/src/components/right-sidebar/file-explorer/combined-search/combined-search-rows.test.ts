import { describe, expect, it } from 'vitest'
import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import { buildSearchRows } from '../content-search/search-rows'
import {
  createCombinedSearchRows,
  moveActiveCombinedSearchIndex,
  resolveActiveCombinedSearchIndex,
  type CombinedSearchRowModel
} from './combined-search-rows'
import { findNameMatches } from './name-match-results'

const NAMES = Array.from({ length: 7 }, (_, index) => `src/cart/cart${index}.ts`)

function names(limit: number | null) {
  return findNameMatches({
    relativePaths: NAMES,
    query: 'cart',
    worktreePath: '/repo',
    displayRootPath: '/repo',
    showDotfiles: true,
    limit
  })
}

function textResult(totalMatches: number, truncated = false): SearchResult {
  return {
    totalMatches,
    truncated,
    files: [
      {
        filePath: '/repo/src/a.ts',
        relativePath: 'src/a.ts',
        matches: [
          { line: 1, column: 1, matchLength: 4, lineContent: 'cart a' },
          { line: 2, column: 1, matchLength: 4, lineContent: 'cart b' }
        ]
      }
    ]
  }
}

function keys(model: CombinedSearchRowModel): string[] {
  return Array.from({ length: model.count }, (_, index) => model.getKey(index))
}

describe('createCombinedSearchRows', () => {
  it('lists capped file names with Show all, then the text section', () => {
    const text = textResult(2)
    const model = createCombinedSearchRows({
      names: names(5),
      textResult: text,
      textRows: buildSearchRows(text, new Set()),
      textPending: false
    })
    expect(keys(model)).toEqual([
      'section:files',
      'name:src/cart/cart0.ts',
      'name:src/cart/cart1.ts',
      'name:src/cart/cart2.ts',
      'name:src/cart/cart3.ts',
      'name:src/cart/cart4.ts',
      'show-all',
      'section:text',
      'file:/repo/src/a.ts',
      'match:/repo/src/a.ts:1:1:0',
      'match:/repo/src/a.ts:2:1:1'
    ])
    expect(model.getRow(0)).toEqual({ type: 'section', section: 'files', count: '7' })
    expect(model.getRow(6)).toEqual({ type: 'show-all', total: 7 })
  })

  it('drops Show all once every name is listed', () => {
    const model = createCombinedSearchRows({
      names: names(null),
      textResult: null,
      textRows: [],
      textPending: false
    })
    expect(keys(model)).not.toContain('show-all')
    expect(model.count).toBe(8)
  })

  it('caps the text count at 1000+ and marks truncated counts', () => {
    const big = textResult(2000, true)
    const capped = createCombinedSearchRows({
      names: { total: 0, matches: [] },
      textResult: big,
      textRows: buildSearchRows(big, new Set()),
      textPending: false
    })
    expect(capped.getRow(0)).toEqual({ type: 'section', section: 'text', count: '1000+' })
    const truncated = textResult(40, true)
    expect(
      createCombinedSearchRows({
        names: null,
        textResult: truncated,
        textRows: buildSearchRows(truncated, new Set()),
        textPending: false
      }).getRow(0)
    ).toEqual({ type: 'section', section: 'text', count: '40+' })
  })

  it('shows No results only after both halves settle empty', () => {
    const empty = { total: 0, matches: [] }
    const settled = { names: empty, textResult: null, textRows: [] }
    expect(keys(createCombinedSearchRows({ ...settled, textPending: false }))).toEqual([
      'no-results'
    ])
    // The Text header stays while a scan runs, so the section never jumps; no global miss yet.
    expect(keys(createCombinedSearchRows({ ...settled, textPending: true }))).toEqual([
      'section:text'
    ])
    expect(createCombinedSearchRows({ ...settled, names: null, textPending: false }).count).toBe(0)
  })
})

describe('combined search keyboard', () => {
  const text = textResult(2)
  const model = createCombinedSearchRows({
    names: names(5),
    textResult: text,
    textRows: buildSearchRows(text, new Set()),
    textPending: false
  })

  it('starts on the first result and keeps a remembered row while it exists', () => {
    expect(resolveActiveCombinedSearchIndex(model, null)).toBe(1)
    expect(resolveActiveCombinedSearchIndex(model, 'file:/repo/src/a.ts')).toBe(8)
    expect(resolveActiveCombinedSearchIndex(model, 'name:gone.ts')).toBe(1)
  })

  it('moves across both sections, skipping headers and stopping at the ends', () => {
    expect(moveActiveCombinedSearchIndex(model, 6, 1)).toBe(8)
    expect(moveActiveCombinedSearchIndex(model, 8, -1)).toBe(6)
    expect(moveActiveCombinedSearchIndex(model, 1, -1)).toBe(1)
    expect(moveActiveCombinedSearchIndex(model, 10, 1)).toBe(10)
  })
})

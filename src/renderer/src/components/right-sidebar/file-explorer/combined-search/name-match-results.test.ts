import { describe, expect, it } from 'vitest'
import { findNameMatches, getNameMatchRanges } from './name-match-results'

const ROOT = '/repo'
const PATHS = [
  'src/cart/useCart.ts',
  'docs/cart/guide.md',
  'src/cart/cartStore.ts',
  'src/cart/CartDrawer.tsx',
  'src/cart/cartTotals.ts',
  'src/cart/CartBadge.tsx',
  'src/cart/cart.test.ts',
  '.github/cart.yml',
  'public/icons/cart-icon.svg'
]

function find(query: string, limit: number | null, overrides: { displayRootPath?: string } = {}) {
  return findNameMatches({
    relativePaths: PATHS,
    query,
    worktreePath: ROOT,
    displayRootPath: overrides.displayRootPath ?? ROOT,
    showDotfiles: false,
    limit
  })
}

describe('findNameMatches', () => {
  it('caps the preview but counts every match, ranking file-name hits above folder-only hits', () => {
    const result = find('cart', 5)
    expect(result.total).toBe(8)
    expect(result.matches.map((match) => match.relativePath)).toEqual([
      'src/cart/useCart.ts',
      'src/cart/cart.test.ts',
      'src/cart/cartStore.ts',
      'src/cart/CartBadge.tsx',
      'src/cart/cartTotals.ts'
    ])
  })

  it('returns every match in the same order when not capped', () => {
    const preview = find('cart', 5).matches.map((match) => match.relativePath)
    const all = find('cart', null).matches.map((match) => match.relativePath)
    expect(all).toHaveLength(8)
    expect(all.slice(0, 5)).toEqual(preview)
    expect(all.at(-1)).toBe('docs/cart/guide.md')
  })

  it('splits name and folder and keeps only paths under a scoped root', () => {
    const result = find('badge', null, { displayRootPath: `${ROOT}/src` })
    expect(result.matches).toEqual([
      {
        relativePath: 'src/cart/CartBadge.tsx',
        name: 'CartBadge.tsx',
        dir: 'src/cart',
        ranges: [[4, 9]]
      }
    ])
    expect(find('guide', null, { displayRootPath: `${ROOT}/src` }).total).toBe(0)
  })

  it('matches nothing for a blank query', () => {
    expect(find('   ', 5)).toEqual({ total: 0, matches: [] })
  })
})

describe('getNameMatchRanges', () => {
  it('merges overlapping token hits case-insensitively', () => {
    expect(getNameMatchRanges('CartDrawer.tsx', ['cart', 'tdr', 'tsx'])).toEqual([
      [0, 6],
      [11, 14]
    ])
  })

  it('skips highlighting when case folding changes the length', () => {
    expect(getNameMatchRanges('İndex.ts', ['index'])).toEqual([])
  })
})

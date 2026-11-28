import { expect, it } from 'vitest'
import { rankedAccounts, withRank } from './claude-account-rotation-ranks'

const A = 'aaaaaaaa-0000'
const B = 'bbbbbbbb-0000'
const C = 'cccccccc-0000'
const shown = [A, B, C]
// `a` is listed by a prefix and by its full id; `dddddddd` is an account not on this Mac.
const preferred = ['aaaaaaaa', A, 'bbbbbbbb', 'dddddddd']

it('gives an account listed by both its id and a prefix one place', () => {
  expect(rankedAccounts(preferred, shown)).toEqual([A, B])
})

it('saves an account at the place the menu offered', () => {
  // The menu offers an unranked account the place right after the ranked ones, here 3.
  const placed = withRank(preferred, shown, C, 3)
  expect(placed).toEqual([A, B, C, 'dddddddd'])
  expect(rankedAccounts(placed, shown).indexOf(C) + 1).toBe(3)
  expect(withRank(preferred, shown, A, 2)).toEqual([B, A, 'dddddddd'])
  expect(withRank(preferred, shown, A, null)).toEqual([B, 'dddddddd'])
})

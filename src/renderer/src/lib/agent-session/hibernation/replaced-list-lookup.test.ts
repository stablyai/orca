import { expect, it } from 'vitest'
import { ReplacedListLookup } from './replaced-list-lookup'

it('still finds an item of an already indexed list after its positions are dropped', () => {
  const lookup = new ReplacedListLookup<string>((id) => id)
  const tabs = ['a', 'b', 'c']
  expect(lookup.find(tabs, 'c')).toBe('c')

  // The coordinator stopped and started again: the same tabs list is read anew.
  lookup.clear()
  expect(lookup.find(tabs, 'c')).toBe('c')

  // Another list overflows the retained positions; the first list's items are still found.
  const wide = Array.from({ length: 5_000 }, (_, index) => `wide-${index}`)
  expect(lookup.find(wide, 'wide-4999')).toBe('wide-4999')
  expect(lookup.find(tabs, 'b')).toBe('b')
  expect(lookup.find(tabs, 'missing')).toBeUndefined()
})

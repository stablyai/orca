import { describe, expect, it } from 'vitest'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import { filterNativeChatRailItems, nativeChatRailRowDisplay } from './native-chat-rail-filter'

function item(id: string, text: string, hasImages = false): NativeChatRailItem {
  return { id, slotIndex: 0, text, hasImages, timestamp: null }
}

function marked(label: string, query: string): string {
  const [result] = filterNativeChatRailItems([item('m', label)], query)
  if (!result) {
    return '(no match)'
  }
  const { text, mark } = nativeChatRailRowDisplay(label, result.match)
  return mark === null
    ? text
    : `${text.slice(0, mark.start)}[${text.slice(mark.start, mark.end)}]${text.slice(mark.end)}`
}

describe('filterNativeChatRailItems', () => {
  it('maps a locale-folded match back to original offsets', () => {
    // İ lowercases to two code units, which would shift a naive mark onto the space.
    expect(filterNativeChatRailItems([item('m', 'İx X')], 'x')[0]?.match).toEqual({
      start: 1,
      end: 2
    })
    expect(
      filterNativeChatRailItems([item('m', 'make the rail calmer')], 'RAIL')[0]?.match
    ).toEqual({ start: 9, end: 13 })
  })

  it('lists every item with no query and only matches with one', () => {
    const items = [item('a', 'alpha'), item('b', 'beta')]
    expect(filterNativeChatRailItems(items, '  ').map((result) => result.item.id)).toEqual([
      'a',
      'b'
    ])
    expect(filterNativeChatRailItems(items, 'ET').map((result) => result.item.id)).toEqual(['b'])
  })

  it('searches the first 200 characters of the words, never the fallback label', () => {
    const long = `${'a'.repeat(196)}needle`
    expect(filterNativeChatRailItems([item('m', long)], 'need')).toHaveLength(1)
    expect(filterNativeChatRailItems([item('m', long)], 'needle')).toHaveLength(0)
    expect(filterNativeChatRailItems([item('m', '', true)], 'image')).toHaveLength(0)
  })
})

describe('nativeChatRailRowDisplay', () => {
  it('starts a later match at the match with a leading ellipsis', () => {
    expect(marked(`${'x '.repeat(80)}needle tail`, 'needle')).toBe('…[needle] tail')
    expect(marked('İx X', 'x')).toBe('…[x] X')
  })

  it('leaves a row whose match is at the start unchanged', () => {
    expect(marked('needle first', 'NEEDLE')).toBe('[needle] first')
  })

  it('never splits a grapheme with the cut or the mark', () => {
    // A combining accent and a ZWJ family stay whole around a match inside them.
    expect(marked('café au lait', 'e')).toBe('…[é] au lait')
    const family = '👨‍👩‍👧'
    expect(marked(`go ${family} home`, '‍👩')).toBe(`…[${family}] home`)
    // A match inside the first grapheme removes no prefix, so it adds no ellipsis.
    expect(marked('éclair', '́')).toBe('[é]clair')
  })
})

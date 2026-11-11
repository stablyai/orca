import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../tab-types'
import { equalizeSplitRunRatios } from './tab-group-layout-tree'

const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const split = (
  direction: 'horizontal' | 'vertical',
  ratio: number,
  first: TabGroupLayoutNode,
  second: TabGroupLayoutNode
): TabGroupLayoutNode => ({ type: 'split', direction, ratio, first, second })

describe('equalizeSplitRunRatios', () => {
  it('counts a cross-axis split as one group and keeps its ratio', () => {
    // a | (b over c) | d, nested as a | ((b over c) | d)
    const column = split('vertical', 0.8, leaf('b'), leaf('c'))
    const root = split('horizontal', 0.6, leaf('a'), split('horizontal', 0.3, column, leaf('d')))

    expect(equalizeSplitRunRatios(root, ['second'])).toEqual(
      split('horizontal', 1 / 3, leaf('a'), split('horizontal', 0.5, column, leaf('d')))
    )
  })

  it('leaves the outer run alone when the split sits under a cross-axis parent', () => {
    const row = split('horizontal', 0.2, leaf('b'), leaf('c'))
    const root = split('vertical', 0.7, leaf('a'), row)

    const next = equalizeSplitRunRatios(root, ['second'])

    expect(next).toEqual(
      split('vertical', 0.7, leaf('a'), split('horizontal', 0.5, leaf('b'), leaf('c')))
    )
  })

  it('returns the same tree for a path that names no split', () => {
    const root = split('horizontal', 0.3, leaf('a'), leaf('b'))

    expect(equalizeSplitRunRatios(root, ['first'])).toBe(root)
    expect(equalizeSplitRunRatios(root, ['third'])).toBe(root)
  })
})

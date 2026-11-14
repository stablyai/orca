import { describe, expect, it } from 'vitest'
import { buildLineageRowProjection, type LineageRail } from './lineage-row-projection'
import type { RenderRow } from './render-row'
import { makeWorktree } from '../../worktree-card-slot-fixture-seeds'

function railXs(rail: LineageRail | null | undefined): number[] {
  const xs: number[] = []
  for (let node = rail; node; node = node.next) {
    xs.push(node.x)
  }
  return xs
}

function item(id: string, depth: number): RenderRow {
  return {
    type: 'item',
    rowKey: id,
    sectionKey: 'all',
    worktree: makeWorktree({ id, name: id, agents: [] }, 0),
    repo: undefined,
    depth,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

describe('lineage row guides', () => {
  // root
  // ├ mid
  // │ ├ a
  // │ │ └ a1
  // │ └ b
  // └ sib
  // solo
  const rows = [
    item('root', 0),
    item('mid', 1),
    item('a', 2),
    item('a1', 3),
    item('b', 2),
    item('sib', 1),
    item('solo', 0)
  ]
  const { frames } = buildLineageRowProjection(rows, 'none', true)
  const guides = frames.map((frame) => frame.guides)
  const x = (index: number) => frames[index].left - 8

  it('leaves standalone rows without connectors', () => {
    expect(guides[6]).toBeNull()
  })

  it('drops a stem from each expanded parent toward its children', () => {
    expect(guides[0]).toEqual({ rails: null, branch: null, stem: x(1) })
    expect(guides[1]?.stem).toBe(x(2))
    expect(guides[2]?.stem).toBe(x(3))
    expect(guides[4]?.stem).toBeNull()
  })

  it('tees into children with later siblings and elbows into the last child', () => {
    expect(guides[1]?.branch).toMatchObject({ x: x(1), last: false })
    expect(guides[2]?.branch).toMatchObject({ x: x(2), last: false })
    expect(guides[4]?.branch).toMatchObject({ x: x(4), last: true })
    expect(guides[5]?.branch).toMatchObject({ x: x(5), last: true })
  })

  it('ends each elbow at the child card border', () => {
    expect(guides[1]?.branch?.to).toBe(frames[1].left + 5)
  })

  it('carries ancestor lines through rows nested under a non-last branch', () => {
    // a1 sits under a (has sibling b) under mid (has sibling sib).
    expect(railXs(guides[3]?.rails)).toEqual([x(2), x(1)])
    // b is mid's last child, but mid still has sibling sib below.
    expect(railXs(guides[4]?.rails)).toEqual([x(1)])
    expect(guides[5]?.rails).toBeNull()
  })

  it('aligns legacy guides with the narrower status dot', () => {
    const legacy = buildLineageRowProjection(rows, 'none', false).frames
    expect(legacy[1].guides?.branch?.x).toBe(legacy[1].left - 10)
  })

  it('keeps a deep single-child chain free of rails', () => {
    const chain = Array.from({ length: 1_000 }, (_, depth) => item(`c${depth}`, depth))
    const chainFrames = buildLineageRowProjection(chain, 'none', true).frames
    expect(chainFrames.every((frame) => frame.guides?.rails === null)).toBe(true)
    expect(chainFrames.slice(1).every((frame) => frame.guides?.branch?.last)).toBe(true)
  })

  it('adds at most one rail per row on a deep branching tree', () => {
    // Each chain node has a leaf sibling after its subtree, so every ancestor keeps a rail open.
    const depth = 500
    const comb = [
      ...Array.from({ length: depth }, (_, d) => item(`c${d}`, d)),
      ...Array.from({ length: depth - 1 }, (_, i) => item(`l${depth - 1 - i}`, depth - 1 - i))
    ]
    const combFrames = buildLineageRowProjection(comb, 'none', true).frames
    const cells = new Set<LineageRail>()
    for (const frame of combFrames) {
      const rails = frame.guides?.rails ?? null
      const parentRails = frame.parent === null ? null : combFrames[frame.parent].guides?.rails
      // Shares the parent's list, or prepends exactly one cell to it.
      expect(rails === parentRails || rails?.next === parentRails).toBe(true)
      if (rails) {
        cells.add(rails)
      }
    }
    expect(cells.size).toBeLessThanOrEqual(comb.length)
    expect(railXs(combFrames[depth - 1].guides?.rails)).toHaveLength(depth - 2)
  })
})

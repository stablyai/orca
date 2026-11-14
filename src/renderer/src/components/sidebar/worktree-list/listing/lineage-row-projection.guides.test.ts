import { describe, expect, it } from 'vitest'
import { buildLineageRowProjection } from './lineage-row-projection'
import type { RenderRow } from './render-row'
import { makeWorktree } from '../../worktree-card-slot-fixture-seeds'

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
    expect(guides[0]).toEqual({ rails: [], branch: null, stem: x(1) })
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
    expect(guides[3]?.rails).toEqual([x(2), x(1)])
    // b is mid's last child, but mid still has sibling sib below.
    expect(guides[4]?.rails).toEqual([x(1)])
    expect(guides[5]?.rails).toEqual([])
  })

  it('aligns legacy guides with the narrower status dot', () => {
    const legacy = buildLineageRowProjection(rows, 'none', false).frames
    expect(legacy[1].guides?.branch?.x).toBe(legacy[1].left - 10)
  })

  it('keeps a deep single-child chain linear by sharing the empty rails', () => {
    const chain = Array.from({ length: 1_000 }, (_, depth) => item(`c${depth}`, depth))
    const chainFrames = buildLineageRowProjection(chain, 'none', true).frames
    const firstRails = chainFrames[1].guides?.rails
    expect(firstRails).toEqual([])
    expect(chainFrames.every((frame) => frame.guides?.rails === firstRails)).toBe(true)
    expect(chainFrames.slice(1).every((frame) => frame.guides?.branch?.last)).toBe(true)
  })
})

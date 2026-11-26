import { describe, expect, it } from 'vitest'
import { buildLineageRowProjection, type LineageRail } from './lineage-row-projection'
import type { RenderRow } from './render-row'
import { FIXTURE_REPO, makeWorktree } from '../../worktree-card-slot-fixture-seeds'

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

  it('carries one rail per open ancestor on a deep branching tree', () => {
    const depth = 500
    const comb = [
      ...Array.from({ length: depth }, (_, d) => item(`c${d}`, d)),
      ...Array.from({ length: depth - 1 }, (_, i) => item(`l${depth - 1 - i}`, depth - 1 - i))
    ]
    const combFrames = buildLineageRowProjection(comb, 'none', true).frames
    expect(railXs(combFrames[depth - 1].guides?.rails)).toHaveLength(depth - 2)
  })
})

function projectHeader(key: string, depth = 0): RenderRow {
  return {
    type: 'header',
    key,
    label: key,
    count: 3,
    icon: { kind: 'project' },
    repo: FIXTURE_REPO,
    projectGroupDepth: depth
  }
}

describe('section tree guides', () => {
  // orca
  // ├ a
  // ├ b
  // └ c
  const sectionRows = [projectHeader('orca'), item('a', 0), item('b', 0), item('c', 0)]
  const { frames } = buildLineageRowProjection(sectionRows, 'repo', true)
  // Header padding 10 + icon center 8.
  const sectionX = 18

  it('nests workspace rows under the project header rail', () => {
    expect(frames[1].left).toBe(sectionX + 8)
    expect(frames[1].guides?.branch).toMatchObject({ x: sectionX, last: false })
    expect(frames[2].guides?.branch).toMatchObject({ x: sectionX, last: false })
    expect(frames[3].guides?.branch).toMatchObject({ x: sectionX, last: true })
  })

  it('keeps section children free of ancestor rails', () => {
    expect(frames[1].guides?.rails).toBeNull()
    expect(frames[3].guides?.rails).toBeNull()
  })

  it('passes the section rail through a non-last child subtree only', () => {
    // orca
    // ├ a
    // │ └ b
    // └ c
    const withChild = [projectHeader('orca'), item('a', 0), item('b', 1), item('c', 0)]
    const withChildFrames = buildLineageRowProjection(withChild, 'repo', true).frames
    expect(railXs(withChildFrames[2].guides?.rails)).toEqual([sectionX])

    // orca
    // └ a
    //   └ b
    const lastWithChild = [projectHeader('orca'), item('a', 0), item('b', 1)]
    const lastFrames = buildLineageRowProjection(lastWithChild, 'repo', true).frames
    expect(lastFrames[2].guides?.rails).toBeNull()
  })

  it('starts a new section at the next project header', () => {
    // orca     api
    // └ a      └ b
    const twoSections = [projectHeader('orca'), item('a', 0), projectHeader('api'), item('b', 0)]
    const twoFrames = buildLineageRowProjection(twoSections, 'repo', true).frames
    expect(twoFrames[1].guides?.branch).toMatchObject({ x: sectionX, last: true })
    expect(twoFrames[3].guides?.branch).toMatchObject({ x: sectionX, last: true })
  })

  it('follows the nested project-group header depth', () => {
    const nested = [projectHeader('lab', 2), item('a', 0)]
    const nestedFrames = buildLineageRowProjection(nested, 'repo', true).frames
    // Header padding 10 + 2*10 + icon center 8.
    expect(nestedFrames[1].guides?.branch?.x).toBe(38)
    expect(nestedFrames[1].left).toBe(46)
  })

  it('leaves rows before any header flat and unconnected', () => {
    const leading = [item('solo', 0), projectHeader('orca'), item('a', 0)]
    const leadingFrames = buildLineageRowProjection(leading, 'repo', true).frames
    expect(leadingFrames[0].left).toBe(0)
    expect(leadingFrames[0].guides).toBeNull()
  })
})

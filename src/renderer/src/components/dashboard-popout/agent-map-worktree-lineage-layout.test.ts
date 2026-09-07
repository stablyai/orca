import { describe, expect, it } from 'vitest'
import { AGENT_MAP_WORKTREE_GAP } from './agent-map-worktree-packing'
import { layoutAgentMapWorktreeLineage } from './agent-map-worktree-lineage-layout'

function buildChain(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `worktree-${index.toString().padStart(4, '0')}`,
    parentId: index === 0 ? undefined : `worktree-${(index - 1).toString().padStart(4, '0')}`,
    radius: 32,
    x: 0,
    y: 0
  }))
}

function buildComb(spineCount: number) {
  const worktrees: ReturnType<typeof buildChain> = []
  for (let index = 0; index < spineCount; index += 1) {
    const suffix = index.toString().padStart(4, '0')
    worktrees.push({
      id: `spine-${suffix}`,
      parentId: index === 0 ? undefined : `spine-${(index - 1).toString().padStart(4, '0')}`,
      radius: 32,
      x: 0,
      y: 0
    })
    if (index < spineCount - 1) {
      worktrees.push({
        id: `leaf-${suffix}`,
        parentId: `spine-${suffix}`,
        radius: 24,
        x: 0,
        y: 0
      })
    }
  }
  return worktrees
}

function layoutWithNumericMapSetCount(worktrees: ReturnType<typeof buildChain>) {
  const set = Map.prototype.set
  let numericMapSets = 0
  Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof key === 'number') {
      numericMapSets += 1
    }
    return Reflect.apply(set, this, [key, value])
  } as typeof Map.prototype.set
  try {
    return { layout: layoutAgentMapWorktreeLineage(worktrees), numericMapSets }
  } finally {
    Map.prototype.set = set
  }
}

function layoutWithWorktreePushCount(count: number) {
  const push = Array.prototype.push
  let worktreePushes = 0
  Array.prototype.push = function (...items: unknown[]): number {
    worktreePushes += items.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'id' in item &&
        typeof item.id === 'string' &&
        item.id.startsWith('worktree-')
    ).length
    return Reflect.apply(push, this, items)
  }
  try {
    return {
      layout: layoutAgentMapWorktreeLineage(buildChain(count)),
      worktreePushes
    }
  } finally {
    Array.prototype.push = push
  }
}

describe('layoutAgentMapWorktreeLineage', () => {
  it('keeps branched and linear family coordinates deterministic', () => {
    const layout = layoutAgentMapWorktreeLineage([
      { id: 'root', x: 0, y: 0, radius: 40 },
      { id: 'child-a', parentId: 'root', x: 0, y: 0, radius: 30 },
      { id: 'grandchild-a', parentId: 'child-a', x: 0, y: 0, radius: 25 },
      { id: 'child-b', parentId: 'root', x: 0, y: 0, radius: 45 },
      { id: 'second-root', x: 0, y: 0, radius: 35 },
      { id: 'second-child', parentId: 'second-root', x: 0, y: 0, radius: 20 }
    ])

    expect(layout).toEqual([
      {
        id: 'child-a',
        parentId: 'root',
        radius: 30,
        x: -7.740689238053122,
        y: 42.47172405948656
      },
      {
        id: 'child-b',
        parentId: 'root',
        radius: 45,
        x: 69.93546272327787,
        y: 175.54837055839306
      },
      {
        id: 'grandchild-a',
        parentId: 'child-a',
        radius: 25,
        x: -7.740689238053122,
        y: 125.47172405948656
      },
      { id: 'root', radius: 40, x: 19.097386742612372, y: -55.52827594051344 },
      {
        id: 'second-child',
        parentId: 'second-root',
        radius: 20,
        x: -112.9872940755618,
        y: -73.65876088400047
      },
      {
        id: 'second-root',
        radius: 35,
        x: -112.9872940755618,
        y: -156.65876088400046
      }
    ])
  })

  it('flattens a 1,000-worktree lineage once', () => {
    const { layout, worktreePushes } = layoutWithWorktreePushCount(1_000)

    expect(layout).toHaveLength(1_000)
    expect(worktreePushes).toBeLessThan(5_000)
    for (let index = 1; index < layout.length; index += 1) {
      expect(layout[index].y).toBeGreaterThan(layout[index - 1].y)
      expect(layout[index].y - layout[index - 1].y).toBeGreaterThanOrEqual(
        layout[index].radius + layout[index - 1].radius + AGENT_MAP_WORKTREE_GAP
      )
    }
  })

  it.each([
    [399, 200],
    [999, 500]
  ])('avoids spatial-grid expansion for a %i-worktree comb', (expectedCount, spineCount) => {
    const worktrees = buildComb(spineCount)
    const { layout, numericMapSets } = layoutWithNumericMapSetCount(worktrees)

    expect(layout).toHaveLength(expectedCount)
    expect(numericMapSets).toBeLessThan(10)
    expect(layoutAgentMapWorktreeLineage(worktrees)).toEqual(layout)
  })

  it('keeps a deeply branched lineage finite without recursive stack growth', () => {
    const worktrees = buildComb(2_500)
    const layout = layoutAgentMapWorktreeLineage(worktrees)
    const byId = new Map(layout.map((worktree) => [worktree.id, worktree]))

    expect(layout).toHaveLength(4_999)
    expect(
      layout.every(
        (worktree) =>
          Number.isFinite(worktree.x) &&
          Number.isFinite(worktree.y) &&
          Math.abs(worktree.x) < 1_000_000 &&
          Math.abs(worktree.y) < 1_000_000
      )
    ).toBe(true)
    for (const worktree of layout) {
      if (worktree.parentId) {
        expect(worktree.y).toBeGreaterThan(byId.get(worktree.parentId)!.y)
      }
    }
  })

  it('wraps very large worktree fanout without overlap', () => {
    const layout = layoutAgentMapWorktreeLineage([
      { id: 'parent', x: 0, y: 0, radius: 32 },
      ...Array.from({ length: 300 }, (_, index) => ({
        id: `child-${index}`,
        parentId: 'parent',
        x: 0,
        y: 0,
        radius: 24
      }))
    ])
    const parent = layout.find((worktree) => worktree.id === 'parent')!
    const children = layout.filter(
      (worktree) => 'parentId' in worktree && worktree.parentId === 'parent'
    )
    let minimumGap = Number.POSITIVE_INFINITY

    expect(children.every((child) => child.y > parent.y)).toBe(true)
    for (const [index, child] of children.entries()) {
      for (const other of children.slice(index + 1)) {
        minimumGap = Math.min(
          minimumGap,
          Math.hypot(child.x - other.x, child.y - other.y) - child.radius - other.radius
        )
      }
    }
    expect(minimumGap).toBeGreaterThanOrEqual(AGENT_MAP_WORKTREE_GAP)
  })

  it('packs high-fanout spawn clusters without forcing every workspace below the coordinator', () => {
    const layout = layoutAgentMapWorktreeLineage([
      { id: 'parent', x: 0, y: 0, radius: 32 },
      ...Array.from({ length: 13 }, (_, index) => ({
        id: `child-${index.toString().padStart(2, '0')}`,
        clusterParentId: 'parent',
        x: 0,
        y: 0,
        radius: 24
      }))
    ])
    const parent = layout.find((worktree) => worktree.id === 'parent')!
    const children = layout.filter(
      (worktree) => 'clusterParentId' in worktree && worktree.clusterParentId === 'parent'
    )

    expect(children.some((child) => child.y <= parent.y)).toBe(true)
  })
})

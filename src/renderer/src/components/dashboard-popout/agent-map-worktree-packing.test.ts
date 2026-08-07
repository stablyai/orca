import { describe, expect, it } from 'vitest'
import { AGENT_MAP_WORKTREE_GAP, packAgentMapWorktrees } from './agent-map-worktree-packing'

function circles(count = 80): { id: string; x: number; y: number; radius: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `worktree-${index.toString().padStart(2, '0')}`,
    x: 0,
    y: 0,
    radius: 28 + (index % 7) * 13
  }))
}

function measuredCircles(count = 80): {
  worktrees: ReturnType<typeof circles>
  coordinateReads: () => number
} {
  let reads = 0
  const worktrees = circles(count).map(({ id, radius }) => {
    let x = 0
    let y = 0
    return {
      id,
      radius,
      get x() {
        reads += 1
        return x
      },
      set x(value: number) {
        x = value
      },
      get y() {
        reads += 1
        return y
      },
      set y(value: number) {
        y = value
      }
    }
  })
  return { worktrees, coordinateReads: () => reads }
}

describe('packAgentMapWorktrees', () => {
  it('keeps variable-radius rings deterministic and non-overlapping', () => {
    const first = packAgentMapWorktrees(circles())
    const second = packAgentMapWorktrees(circles())

    expect(second).toEqual(first)
    for (const [index, worktree] of first.entries()) {
      for (const other of first.slice(index + 1)) {
        expect(Math.hypot(worktree.x - other.x, worktree.y - other.y)).toBeGreaterThanOrEqual(
          worktree.radius + other.radius + AGENT_MAP_WORKTREE_GAP - 0.001
        )
      }
    }
  })

  it('indexes rings that span multiple positive and negative grid cells', () => {
    const packed = packAgentMapWorktrees(
      [380, 260, 170, 145, 90].map((radius, index) => ({
        id: `large-${index}`,
        x: 0,
        y: 0,
        radius
      }))
    )

    expect(packed.some((worktree) => worktree.x < 0 || worktree.y < 0)).toBe(true)
    for (const [index, worktree] of packed.entries()) {
      for (const other of packed.slice(index + 1)) {
        expect(Math.hypot(worktree.x - other.x, worktree.y - other.y)).toBeGreaterThanOrEqual(
          worktree.radius + other.radius + AGENT_MAP_WORKTREE_GAP - 0.001
        )
      }
    }
  })

  it('keeps capped large-map packing deterministic and compact', () => {
    const first = packAgentMapWorktrees(circles(300))
    const second = packAgentMapWorktrees(circles(300))

    expect(second).toEqual(first)
    expect(
      Math.max(...first.map((worktree) => Math.hypot(worktree.x, worktree.y) + worktree.radius))
    ).toBeLessThan(1_500)
    let minimumGap = Number.POSITIVE_INFINITY
    for (const [index, worktree] of first.entries()) {
      for (const other of first.slice(index + 1)) {
        minimumGap = Math.min(
          minimumGap,
          Math.hypot(worktree.x - other.x, worktree.y - other.y) - worktree.radius - other.radius
        )
      }
    }
    expect(minimumGap).toBeGreaterThanOrEqual(AGENT_MAP_WORKTREE_GAP - 0.001)
  })

  it('bounds deterministic coordinate checks for larger maps', () => {
    const { worktrees, coordinateReads } = measuredCircles(300)

    packAgentMapWorktrees(worktrees)

    expect(coordinateReads()).toBeLessThan(13_200_000)
  })

  it('bounds packing work for a thousand rings', () => {
    const { worktrees, coordinateReads } = measuredCircles(1_000)
    const packed = packAgentMapWorktrees(worktrees)
    const positions = packed.map(({ id, x, y, radius }) => ({ id, x, y, radius }))

    expect(packed).toHaveLength(1_000)
    expect(
      packed.every((worktree) => Number.isFinite(worktree.x) && Number.isFinite(worktree.y))
    ).toBe(true)
    expect(coordinateReads()).toBeLessThan(10_000_000)
    expect(packAgentMapWorktrees(circles(1_000))).toEqual(positions)
    let minimumGap = Number.POSITIVE_INFINITY
    for (const [index, worktree] of positions.entries()) {
      for (const other of positions.slice(index + 1)) {
        minimumGap = Math.min(
          minimumGap,
          Math.hypot(worktree.x - other.x, worktree.y - other.y) - worktree.radius - other.radius
        )
      }
    }
    expect(minimumGap).toBeGreaterThanOrEqual(AGENT_MAP_WORKTREE_GAP - 0.001)
  })

  it('bounds packing work when one ring dwarfs the rest', () => {
    const { worktrees, coordinateReads } = measuredCircles(1_000)
    worktrees[0].radius = 50_000_000
    const packed = packAgentMapWorktrees(worktrees)

    expect(packed).toHaveLength(1_000)
    expect(
      packed.every((worktree) => Number.isFinite(worktree.x) && Number.isFinite(worktree.y))
    ).toBe(true)
    expect(coordinateReads()).toBeLessThan(10_000_000)
  })

  it('keeps the spatial index bounded for very large rings', () => {
    const set = Map.prototype.set
    let numericMapSets = 0
    Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (typeof key === 'number') {
        numericMapSets += 1
      }
      return Reflect.apply(set, this, [key, value])
    } as typeof Map.prototype.set
    try {
      const packed = packAgentMapWorktrees(
        Array.from({ length: 5 }, (_, index) => ({
          id: `huge-${index}`,
          x: 0,
          y: 0,
          radius: 50_000_000 - index * 1_000_000
        }))
      )

      expect(
        packed.every((worktree) => Number.isFinite(worktree.x) && Number.isFinite(worktree.y))
      ).toBe(true)
      expect(numericMapSets).toBeLessThan(100)
    } finally {
      Map.prototype.set = set
    }
  })
})

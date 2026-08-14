import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentMapDirectLineageChevronPath,
  agentMapLineageChevronPath
} from './agent-map-lineage-chevron-path'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agentMapDirectLineageChevronPath', () => {
  it('runs every chevron directly from the parent toward the child', () => {
    const path = agentMapDirectLineageChevronPath(
      { x: 0, y: 0, radius: 4 },
      { x: 40, y: 40, radius: 4 }
    )
    const tips = [...path.matchAll(/M [-\d.]+ [-\d.]+ L ([-\d.]+) ([-\d.]+) L/g)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2])
    }))

    expect(tips.length).toBeGreaterThan(1)
    expect(tips.every((tip) => tip.x === tip.y)).toBe(true)
    expect(tips.at(-1)?.x).toBeGreaterThan(tips[0].x)
  })

  it('trims the path to unequal node radii', () => {
    expect(
      agentMapDirectLineageChevronPath({ x: 0, y: 0, radius: 2 }, { x: 20, y: 0, radius: 6 })
    ).toBe('M 4.5 2.25 L 8 0 L 4.5 -2.25')
  })

  it('does not reverse direction when node boundaries overlap', () => {
    expect(
      agentMapDirectLineageChevronPath({ x: 0, y: 0, radius: 10 }, { x: 15, y: 0, radius: 10 })
    ).toBe('M 0 0')
  })

  it('omits a chevron that cannot fit between trimmed node boundaries', () => {
    expect(
      agentMapDirectLineageChevronPath({ x: 0, y: 0, radius: 10 }, { x: 25, y: 0, radius: 10 })
    ).toBe('M 10 0')
  })

  it('caps decorative chevrons on long links', () => {
    const path = agentMapDirectLineageChevronPath(
      { x: 0, y: 0, radius: 0 },
      { x: 10_000, y: 0, radius: 0 }
    )

    expect(path.match(/\bM\b/g)).toHaveLength(256)
  })

  it('keeps the same chevron pitch however far apart the nodes are', () => {
    const pitches = [60, 200, 900].map((distance) => {
      const tips = [
        ...agentMapDirectLineageChevronPath(
          { x: 0, y: 0, radius: 0 },
          { x: distance, y: 0, radius: 0 }
        ).matchAll(/M [-\d.]+ [-\d.]+ L ([-\d.]+) [-\d.]+ L/g)
      ].map((match) => Number(match[1]))

      expect(tips.length).toBeGreaterThan(2)
      return tips.slice(1).map((tip, index) => tip - tips[index])
    })

    expect(pitches.flat().every((pitch) => pitch === 8)).toBe(true)
  })

  it('keeps fixed pitch across degenerate and multi-segment paths', () => {
    const path = agentMapLineageChevronPath([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 23 },
      { x: 30, y: 23 }
    ])
    const tips = [...path.matchAll(/M [-\d.]+ [-\d.]+ L ([-\d.]+) ([-\d.]+) L/g)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2])
    }))

    expect(tips).toEqual([
      { x: 6.5, y: 0 },
      { x: 9, y: 5.5 },
      { x: 9, y: 13.5 },
      { x: 9, y: 21.5 },
      { x: 15.5, y: 23 },
      { x: 23.5, y: 23 }
    ])
  })

  it('serves an unmoved edge from cache instead of rebuilding it', async () => {
    vi.resetModules()
    const { agentMapDirectLineageChevronPath: cachedPath } =
      await import('./agent-map-lineage-chevron-path')
    const parent = { x: 3, y: 5, radius: 20 }
    const child = { x: 903, y: 5, radius: 20 }
    const hypot = vi.spyOn(Math, 'hypot')
    const first = cachedPath(parent, child)

    expect(hypot).toHaveBeenCalled()
    hypot.mockClear()
    const second = cachedPath({ ...parent }, { ...child })

    expect(hypot).not.toHaveBeenCalled()
    expect(second).toBe(first)
  })

  it('keeps 512 recently used paths and evicts the least-recently-used path', async () => {
    vi.resetModules()
    const { agentMapDirectLineageChevronPath: cachedPath } =
      await import('./agent-map-lineage-chevron-path')
    const edge = (x: number) =>
      [
        { x, y: 1_000, radius: 2 },
        { x, y: 1_200, radius: 2 }
      ] as const
    for (let i = 0; i < 512; i += 1) {
      cachedPath(...edge(i))
    }

    const hypot = vi.spyOn(Math, 'hypot')
    cachedPath(...edge(0))
    expect(hypot).not.toHaveBeenCalled()

    cachedPath(...edge(512))
    hypot.mockClear()
    cachedPath(...edge(1))
    expect(hypot).toHaveBeenCalled()

    hypot.mockClear()
    cachedPath(...edge(0))
    expect(hypot).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { agentMapDirectLineageChevronPath } from './agent-map-lineage-chevron-path'

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

    expect(path.match(/\bM\b/g)).toHaveLength(32)
  })
})

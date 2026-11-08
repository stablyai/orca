import { describe, expect, it } from 'vitest'
import { buildRoadmapTicks, parseRoadmapDate, type RoadmapSpan } from './project-roadmap-timeline'

const utc = (iso: string): number => Date.parse(`${iso}T00:00:00Z`)

describe('parseRoadmapDate', () => {
  it('rejects invalid calendar dates instead of letting Date.UTC normalize them', () => {
    expect(parseRoadmapDate('2026-02-30')).toBeNull()
    expect(parseRoadmapDate('2026-13-01')).toBeNull()
    expect(parseRoadmapDate('2026-04-31')).toBeNull()
    expect(parseRoadmapDate('2024-02-29')).toBe(Date.parse('2024-02-29T00:00:00Z'))
  })
})

describe('buildRoadmapTicks', () => {
  const span = (from: string, to: string): RoadmapSpan => ({
    startMs: utc(from),
    endMs: utc(to),
    point: false
  })

  it('caps the grid instead of expanding for a far-future date, keeping today visible', () => {
    const today = utc('2026-03-15')
    const ticks = buildRoadmapTicks([span('2026-03-02', '9999-01-01')], 'month', today)
    expect(ticks).toHaveLength(480)
    expect(ticks[0]!.startMs).toBeLessThanOrEqual(today)
    expect(ticks.at(-1)!.endMs).toBeGreaterThan(today)
  })

  it('caps the grid for a far-past date without pushing today off the edge', () => {
    const today = utc('2026-03-15')
    const ticks = buildRoadmapTicks([span('0206-03-02', '0206-03-10')], 'month', today)
    expect(ticks).toHaveLength(480)
    expect(ticks[0]!.startMs).toBeLessThanOrEqual(today)
    expect(ticks.at(-1)!.endMs).toBeGreaterThan(today)
    // One month of trailing padding after today survives the trim.
    expect(ticks.at(-1)!.endMs).toBe(utc('2026-05-01'))
  })
})

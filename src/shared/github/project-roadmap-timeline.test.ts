import { describe, expect, it } from 'vitest'
import {
  buildRoadmapTicks,
  getRoadmapSpan,
  parseRoadmapDate,
  resolveRoadmapDateSource,
  roadmapOffsetPx,
  ROADMAP_DAY_MS,
  type RoadmapSpan
} from './project-roadmap-timeline'
import type {
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectRow,
  GitHubProjectView
} from './project-types'

function dateField(id: string, name: string): GitHubProjectField {
  return { kind: 'field', id, name, dataType: 'DATE' }
}

function iterationField(id: string, name: string): GitHubProjectField {
  return { kind: 'iteration', id, name, dataType: 'ITERATION', iterations: [] }
}

function view(fields: GitHubProjectField[]): GitHubProjectView {
  return {
    id: 'PVTV_1',
    number: 1,
    name: 'Roadmap',
    layout: 'ROADMAP_LAYOUT',
    filter: '',
    fields,
    groupByFields: [],
    sortByFields: []
  }
}

function row(values: GitHubProjectFieldValue[]): GitHubProjectRow {
  const fieldValuesByFieldId: Record<string, GitHubProjectFieldValue> = {}
  for (const value of values) {
    fieldValuesByFieldId[value.fieldId] = value
  }
  return {
    id: 'PVTI_1',
    itemType: 'ISSUE',
    content: {
      number: 1,
      title: 'Item',
      body: null,
      url: 'https://github.com/o/r/issues/1',
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository: 'o/r',
      assignees: [],
      labels: [],
      parentIssue: null,
      issueType: null
    },
    fieldValuesByFieldId,
    updatedAt: '2026-08-31T00:00:00Z',
    position: 0
  }
}

const utc = (iso: string): number => Date.parse(`${iso}T00:00:00Z`)

describe('resolveRoadmapDateSource', () => {
  it('pairs date fields by name regardless of view order', () => {
    const target = dateField('f_end', 'Target date')
    const start = dateField('f_start', 'Start date')
    expect(resolveRoadmapDateSource(view([target, start]))).toEqual({
      kind: 'date-range',
      startField: start,
      targetField: target
    })
  })

  it('keeps a name-matched field in its role when the other name matches nothing', () => {
    const review = dateField('f_review', 'Review date')
    const start = dateField('f_start', 'Start date')
    expect(resolveRoadmapDateSource(view([review, start]))).toEqual({
      kind: 'date-range',
      startField: start,
      targetField: review
    })
  })

  it('finds placement fields via sortByFields when the visible list hides them', () => {
    const start = dateField('f_start', 'Start date')
    const target = dateField('f_end', 'Target date')
    const hidden = view([{ kind: 'field', id: 'f_t', name: 'Title', dataType: 'TITLE' }])
    hidden.sortByFields = [
      { direction: 'ASC', field: start },
      { direction: 'ASC', field: target }
    ]
    expect(resolveRoadmapDateSource(hidden)).toEqual({
      kind: 'date-range',
      startField: start,
      targetField: target
    })
  })

  it('derives placement fields from row values when no configured field has them', () => {
    const bare = view([{ kind: 'field', id: 'f_t', name: 'Title', dataType: 'TITLE' }])
    const rows = [
      row([
        { kind: 'date', fieldId: 'f_start', date: '2026-03-02', fieldName: 'Start date' },
        { kind: 'date', fieldId: 'f_end', date: '2026-03-04', fieldName: 'Target date' }
      ])
    ]
    expect(resolveRoadmapDateSource(bare, rows)).toEqual({
      kind: 'date-range',
      startField: { kind: 'field', id: 'f_start', name: 'Start date', dataType: 'DATE' },
      targetField: { kind: 'field', id: 'f_end', name: 'Target date', dataType: 'DATE' }
    })
  })

  it('falls back to view order when names do not match the patterns', () => {
    const first = dateField('f_1', '開始')
    const second = dateField('f_2', '完了')
    expect(resolveRoadmapDateSource(view([first, second]))).toEqual({
      kind: 'date-range',
      startField: first,
      targetField: second
    })
  })

  it('prefers an iteration field over a lone date field', () => {
    const iteration = iterationField('f_it', 'Sprint')
    expect(resolveRoadmapDateSource(view([dateField('f_1', 'Start date'), iteration]))).toEqual({
      kind: 'iteration',
      field: iteration
    })
  })

  it('uses a lone date field as a point source', () => {
    const only = dateField('f_1', 'Ship date')
    expect(resolveRoadmapDateSource(view([only]))).toEqual({ kind: 'date-point', field: only })
  })

  it('returns null when the view has nothing to place items on', () => {
    expect(
      resolveRoadmapDateSource(
        view([{ kind: 'field', id: 'f_t', name: 'Title', dataType: 'TITLE' }])
      )
    ).toBeNull()
  })
})

describe('getRoadmapSpan', () => {
  const start = dateField('f_start', 'Start date')
  const target = dateField('f_end', 'Target date')
  const source = { kind: 'date-range', startField: start, targetField: target } as const

  it('spans an inclusive end date', () => {
    const span = getRoadmapSpan(
      row([
        { kind: 'date', fieldId: 'f_start', date: '2026-03-02' },
        { kind: 'date', fieldId: 'f_end', date: '2026-03-04' }
      ]),
      source
    )
    expect(span).toEqual({ startMs: utc('2026-03-02'), endMs: utc('2026-03-05'), point: false })
  })

  it('renders a single known date as a point', () => {
    const span = getRoadmapSpan(
      row([{ kind: 'date', fieldId: 'f_end', date: '2026-03-04' }]),
      source
    )
    expect(span).toEqual({ startMs: utc('2026-03-04'), endMs: utc('2026-03-05'), point: true })
  })

  it('orders an inverted pair instead of dropping the row', () => {
    const span = getRoadmapSpan(
      row([
        { kind: 'date', fieldId: 'f_start', date: '2026-03-10' },
        { kind: 'date', fieldId: 'f_end', date: '2026-03-01' }
      ]),
      source
    )
    expect(span).toEqual({ startMs: utc('2026-03-01'), endMs: utc('2026-03-11'), point: false })
  })

  it('returns null when neither date is set', () => {
    expect(getRoadmapSpan(row([]), source)).toBeNull()
  })

  it('derives the span from an iteration value', () => {
    const span = getRoadmapSpan(
      row([
        {
          kind: 'iteration',
          fieldId: 'f_it',
          iterationId: 'it_1',
          title: 'Sprint 1',
          startDate: '2026-03-02',
          duration: 14
        }
      ]),
      { kind: 'iteration', field: iterationField('f_it', 'Sprint') }
    )
    expect(span).toEqual({
      startMs: utc('2026-03-02'),
      endMs: utc('2026-03-02') + 14 * ROADMAP_DAY_MS,
      point: false
    })
  })

  it('ignores a value whose kind does not match the source', () => {
    expect(
      getRoadmapSpan(row([{ kind: 'text', fieldId: 'f_start', text: '2026-03-02' }]), source)
    ).toBeNull()
  })
})

describe('parseRoadmapDate', () => {
  it('reads the date part of an ISO timestamp', () => {
    expect(parseRoadmapDate('2026-03-02T11:22:33Z')).toBe(utc('2026-03-02'))
  })

  it('rejects malformed input', () => {
    expect(parseRoadmapDate('March 2')).toBeNull()
  })
})

describe('buildRoadmapTicks', () => {
  const span = (from: string, to: string): RoadmapSpan => ({
    startMs: utc(from),
    endMs: utc(to),
    point: false
  })

  it('pads one month on each side of the covered range', () => {
    const ticks = buildRoadmapTicks([span('2026-03-02', '2026-10-10')], 'month', utc('2026-03-15'))
    expect(ticks[0]?.startMs).toBe(utc('2026-02-01'))
    expect(ticks.at(-1)?.endMs).toBe(utc('2026-12-01'))
  })

  it('always covers today even when every item sits elsewhere', () => {
    const ticks = buildRoadmapTicks([span('2026-03-02', '2026-03-10')], 'month', utc('2026-09-15'))
    expect(ticks[0]?.startMs).toBe(utc('2026-02-01'))
    expect(ticks.at(-1)?.endMs).toBe(utc('2026-11-01'))
  })

  it('widens an empty roadmap to the minimum readable width', () => {
    expect(buildRoadmapTicks([], 'month', utc('2026-03-15'))).toHaveLength(6)
    expect(buildRoadmapTicks([], 'quarter', utc('2026-03-15'))).toHaveLength(4)
    expect(buildRoadmapTicks([], 'year', utc('2026-03-15'))).toHaveLength(3)
  })

  it('snaps quarter and year grids to their unit boundaries', () => {
    const quarters = buildRoadmapTicks(
      [span('2026-05-02', '2026-05-10')],
      'quarter',
      utc('2026-05-15')
    )
    expect(quarters[0]?.startMs).toBe(utc('2026-01-01'))
    const years = buildRoadmapTicks([span('2026-05-02', '2026-05-10')], 'year', utc('2026-05-15'))
    expect(years[0]?.startMs).toBe(utc('2025-01-01'))
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

describe('roadmapOffsetPx', () => {
  const ticks = buildRoadmapTicks([], 'month', utc('2026-03-15'))

  it('interpolates inside the containing tick so column rules stay aligned', () => {
    const second = ticks[1]
    expect(second).toBeDefined()
    expect(roadmapOffsetPx(second!.startMs, ticks, 100)).toBe(100)
    const midpoint = second!.startMs + (second!.endMs - second!.startMs) / 2
    expect(roadmapOffsetPx(midpoint, ticks, 100)).toBeCloseTo(150, 5)
  })

  it('clamps out-of-range timestamps to the grid edges', () => {
    expect(roadmapOffsetPx(utc('1990-01-01'), ticks, 100)).toBe(0)
    expect(roadmapOffsetPx(utc('2090-01-01'), ticks, 100)).toBe(ticks.length * 100)
  })

  it('returns zero for an empty grid', () => {
    expect(roadmapOffsetPx(utc('2026-03-15'), [], 100)).toBe(0)
  })
})

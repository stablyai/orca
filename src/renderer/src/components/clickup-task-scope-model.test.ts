import { describe, expect, it } from 'vitest'
import type { ClickUpList, ClickUpSpace, ClickUpTask } from '../../../shared/clickup-types'
import { buildClickUpGanttLayout, buildClickUpGanttTicks } from './clickup-gantt-model'
import { detectClickUpSprints, findCurrentClickUpSprint } from './clickup-sprints'
import {
  collectClickUpStatusOptions,
  defaultClickUpStatusSelection,
  resolveClickUpStatusSelection
} from './clickup-status-options'
import { matchesClickUpTaskFilter } from './clickup-task-page-model'
import {
  DEFAULT_CLICKUP_TASK_VIEW_PREFERENCES,
  resolveClickUpTaskViewPreferences
} from './clickup-task-view-preferences'

function list(id: string, overrides: Partial<ClickUpList> = {}): ClickUpList {
  return { id, workspaceId: 'team-1', name: id, statuses: [], ...overrides }
}

function status(name: string, type: string, orderIndex = 0) {
  return { name, type, orderIndex, color: '#000000' }
}

function task(id: string, overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures fill only the fields the scope, filter and Gantt helpers read.
  return {
    id,
    workspaceId: 'team-1',
    name: `Task ${id}`,
    url: `https://app.clickup.com/t/${id}`,
    status: status('to do', 'open'),
    assignees: [],
    tags: [],
    list: { id: 'list-1', name: 'Backlog' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  } as ClickUpTask
}

describe('ClickUp sprints', () => {
  const now = new Date(2026, 9, 15, 12)

  it('finds Sprint Lists by Folder or List name and parses name ranges', () => {
    const sprints = detectClickUpSprints(
      [
        list('backlog', { folder: { id: 'f1', name: 'Product' } }),
        list('s12', { name: 'Sprint 12 (10/6 - 10/19)', folder: { id: 'f2', name: 'Sprints' } }),
        list('s11', { name: 'Sprint 11 (9/22 - 10/5)', folder: { id: 'f2', name: 'Sprints' } }),
        list('dated', {
          name: 'Iteration 4',
          folder: { id: 'f2', name: 'Sprint Folder' },
          startDate: '2026-10-20T00:00:00.000Z',
          dueDate: '2026-11-02T00:00:00.000Z'
        })
      ],
      now
    )

    expect(sprints.map((sprint) => sprint.listId)).toEqual(['s11', 's12', 'dated'])
    expect(findCurrentClickUpSprint(sprints, now)?.listId).toBe('s12')
  })

  it('reports no current sprint when none covers today', () => {
    const sprints = detectClickUpSprints([list('Sprint 3')], now)
    expect(sprints).toHaveLength(1)
    expect(findCurrentClickUpSprint(sprints, now)).toBeNull()
  })
})

describe('ClickUp status options', () => {
  const space: ClickUpSpace = {
    id: 'space-1',
    name: 'Platform',
    workspaceId: 'team-1',
    statuses: [status('to do', 'open'), status('in progress', 'custom', 1)]
  }

  it('merges Space and List-override statuses, finished statuses last', () => {
    const options = collectClickUpStatusOptions(space, [
      list('l1', {
        statuses: [status('Complete', 'closed', 9), status('on prod env', 'done', 8)]
      }),
      list('l2', { statuses: [status('TO DO', 'open')] })
    ])
    expect(options.map((option) => option.name)).toEqual([
      'to do',
      'in progress',
      'on prod env',
      'Complete'
    ])
    expect(defaultClickUpStatusSelection(options)).toEqual(['to do', 'in progress'])
  })

  it('keeps a saved selection but drops statuses the Space no longer has', () => {
    const options = collectClickUpStatusOptions(space, [])
    expect(resolveClickUpStatusSelection(options, ['In Progress', 'gone'])).toEqual(['In Progress'])
    expect(resolveClickUpStatusSelection(options, ['gone'])).toEqual(['to do', 'in progress'])
    expect(resolveClickUpStatusSelection(options, [])).toEqual([])
  })
})

describe('ClickUp task view preferences', () => {
  it('falls back to defaults for corrupt storage', () => {
    expect(resolveClickUpTaskViewPreferences('nope')).toEqual(DEFAULT_CLICKUP_TASK_VIEW_PREFERENCES)
    expect(
      resolveClickUpTaskViewPreferences({
        spaceByWorkspace: { 'team-1': 'space-1', bad: 4 },
        statusesBySpace: { 'space-1': ['to do', 3] },
        sprintBySpace: { 'space-1': { listId: 's12' }, other: 'bogus' },
        view: 'gantt',
        ganttZoom: 'week',
        ganttGroupBy: 'status'
      })
    ).toEqual({
      spaceByWorkspace: { 'team-1': 'space-1' },
      statusesBySpace: { 'space-1': ['to do'] },
      sprintBySpace: { 'space-1': { listId: 's12' } },
      sprintFolderBySpace: {},
      view: 'gantt',
      ganttZoom: 'week',
      ganttGroupBy: 'status'
    })
  })
})

describe('matchesClickUpTaskFilter', () => {
  it('applies the assignee and state filters to search results', () => {
    const mine = task('a', { assignees: [{ id: 7, username: 'Ada' }] })
    const closed = task('b', { status: status('complete', 'closed') })
    expect(matchesClickUpTaskFilter(mine, 'assigned', 7)).toBe(true)
    expect(matchesClickUpTaskFilter(closed, 'assigned', 7)).toBe(false)
    expect(matchesClickUpTaskFilter(closed, 'completed', 7)).toBe(true)
    expect(matchesClickUpTaskFilter(closed, 'open', 7)).toBe(false)
    expect(matchesClickUpTaskFilter(closed, 'all', 7)).toBe(true)
  })
})

describe('ClickUp Gantt layout', () => {
  const now = new Date(2026, 9, 15, 9)

  it('places bars, due-only milestones and unscheduled tasks', () => {
    const layout = buildClickUpGanttLayout(
      [
        task('bar', {
          startDate: new Date(2026, 9, 13).toISOString(),
          dueDate: new Date(2026, 9, 16).toISOString()
        }),
        task('milestone', { dueDate: new Date(2026, 9, 20).toISOString() }),
        task('none')
      ],
      'list',
      now
    )

    // Range starts three days before the earliest date (Oct 13).
    expect(layout.rangeStart).toEqual(new Date(2026, 9, 10))
    expect(layout.todayOffset).toBe(5)
    expect(layout.groups).toHaveLength(1)
    expect(layout.groups[0]!.bars).toMatchObject([
      { task: { id: 'bar' }, startDay: 3, spanDays: 4, milestone: false },
      { task: { id: 'milestone' }, startDay: 10, spanDays: 1, milestone: true }
    ])
    expect(layout.unscheduled.map((item) => item.id)).toEqual(['none'])
    expect(layout.totalDays).toBe(14)
  })

  it('groups by status and survives tasks with no dates at all', () => {
    const layout = buildClickUpGanttLayout([task('x')], 'status', now)
    expect(layout.groups).toEqual([])
    expect(layout.unscheduled).toHaveLength(1)
    expect(layout.todayOffset).toBe(3)
  })

  it('labels every day at day zoom and Mondays at week zoom', () => {
    const start = new Date(2026, 9, 10)
    expect(buildClickUpGanttTicks(start, 14, 'day', 'en-US')).toHaveLength(14)
    expect(buildClickUpGanttTicks(start, 14, 'week', 'en-US').map((tick) => tick.offset)).toEqual([
      2, 9
    ])
  })
})

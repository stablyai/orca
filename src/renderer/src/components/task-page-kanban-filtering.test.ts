import { describe, expect, it } from 'vitest'
import type { KanbanPerson, KanbanTaskSummary } from '../../../shared/kanban-types'
import {
  applyKanbanTaskFilterAndSort,
  createDefaultKanbanTaskFilter,
  filterKanbanTasks,
  sortKanbanTasks
} from './task-page-kanban-filtering'

const viewer: KanbanPerson = { id: 'u1', name: 'User One' }
const other: KanbanPerson = { id: 'u2', name: 'User Two' }

const NOW = Date.parse('2026-08-27T12:00:00.000Z')

function makeTask(overrides: Partial<KanbanTaskSummary>): KanbanTaskSummary {
  return {
    id: 't1',
    title: 'Task one',
    laneId: 'lane-open',
    laneName: 'Открыто',
    due: null,
    urgent: false,
    repositoryUrls: [],
    taskVersion: 1,
    executors: [viewer],
    observers: [],
    createdBy: viewer,
    url: 'https://kanban.fpimi.ru/?task=t1',
    ...overrides
  }
}

const executorTask = makeTask({
  id: 't1',
  title: 'Alpha executor',
  laneId: 'lane-open',
  laneName: 'Открыто',
  urgent: false,
  due: '2026-08-28',
  executors: [viewer],
  observers: [],
  createdBy: other
})

const observerTask = makeTask({
  id: 't2',
  title: 'Bravo observed',
  laneId: 'lane-open',
  laneName: 'Открыто',
  urgent: false,
  due: null,
  executors: [other],
  observers: [viewer],
  createdBy: other
})

const creatorTask = makeTask({
  id: 't3',
  title: 'Charlie created',
  laneId: 'lane-open',
  laneName: 'Открыто',
  urgent: false,
  due: null,
  executors: [other],
  observers: [],
  createdBy: viewer
})

const doneTask = makeTask({
  id: 't4',
  title: 'Delta done',
  laneId: 'lane-done',
  laneName: 'Сделано',
  urgent: false,
  due: null,
  executors: [viewer],
  observers: [],
  createdBy: viewer
})

const ALL_TASKS = [executorTask, observerTask, creatorTask, doneTask]

describe('createDefaultKanbanTaskFilter', () => {
  it('defaults to executor role without done tasks', () => {
    expect(createDefaultKanbanTaskFilter()).toEqual({ role: 'executor' })
  })
})

describe('filterKanbanTasks', () => {
  it('default executor filter keeps open executor tasks only', () => {
    const result = filterKanbanTasks({
      tasks: ALL_TASKS,
      viewerId: viewer.id,
      filter: { role: 'executor' }
    })
    expect(result.map((task) => task.id)).toEqual(['t1'])
  })

  it('observer mode keeps tasks the viewer observes', () => {
    const result = filterKanbanTasks({
      tasks: ALL_TASKS,
      viewerId: viewer.id,
      filter: { role: 'observer' }
    })
    expect(result.map((task) => task.id)).toEqual(['t2'])
  })

  it('creator mode keeps tasks the viewer created', () => {
    const result = filterKanbanTasks({
      tasks: ALL_TASKS,
      viewerId: viewer.id,
      filter: { role: 'creator' }
    })
    expect(result.map((task) => task.id)).toEqual(['t3'])
  })

  it('creator mode with includeDone keeps created tasks from the done lane too', () => {
    const result = filterKanbanTasks({
      tasks: ALL_TASKS,
      viewerId: viewer.id,
      filter: { role: 'creator', includeDone: true }
    })
    expect(result.map((task) => task.id)).toEqual(['t3', 't4'])
  })

  it('includeDone keeps tasks from the done lane', () => {
    const result = filterKanbanTasks({
      tasks: ALL_TASKS,
      viewerId: viewer.id,
      filter: { role: 'executor', includeDone: true }
    })
    expect(result.map((task) => task.id)).toEqual(['t1', 't4'])
  })

  it('lane filter narrows to the lane id', () => {
    const result = filterKanbanTasks({
      tasks: ALL_TASKS,
      viewerId: viewer.id,
      filter: { role: 'executor', laneId: 'lane-open' }
    })
    expect(result.map((task) => task.id)).toEqual(['t1'])
  })

  it('urgent filter keeps only urgent tasks', () => {
    const urgent = makeTask({
      id: 't5',
      title: 'Urgent one',
      urgent: true,
      due: null,
      executors: [viewer]
    })
    const result = filterKanbanTasks({
      tasks: [executorTask, urgent],
      viewerId: viewer.id,
      filter: { role: 'executor', urgent: true }
    })
    expect(result.map((task) => task.id)).toEqual(['t5'])
  })

  it('overdue due filter keeps past dates only', () => {
    const overdue = makeTask({
      id: 't6',
      title: 'Overdue one',
      due: '2026-08-26',
      executors: [viewer]
    })
    const result = filterKanbanTasks({
      tasks: [executorTask, overdue],
      viewerId: viewer.id,
      filter: { role: 'executor', due: 'overdue' },
      now: () => NOW
    })
    expect(result.map((task) => task.id)).toEqual(['t6'])
  })

  it('today due filter keeps today only', () => {
    const today = makeTask({
      id: 't7',
      title: 'Today one',
      due: '2026-08-27',
      executors: [viewer]
    })
    const result = filterKanbanTasks({
      tasks: [executorTask, today],
      viewerId: viewer.id,
      filter: { role: 'executor', due: 'today' },
      now: () => NOW
    })
    expect(result.map((task) => task.id)).toEqual(['t7'])
  })

  it('week due filter keeps dates up to seven days out', () => {
    const weekEdge = makeTask({
      id: 't8',
      title: 'Week edge',
      due: '2026-09-03',
      executors: [viewer]
    })
    const beyondWeek = makeTask({
      id: 't9',
      title: 'Beyond week',
      due: '2026-09-04',
      executors: [viewer]
    })
    const result = filterKanbanTasks({
      tasks: [weekEdge, beyondWeek],
      viewerId: viewer.id,
      filter: { role: 'executor', due: 'week' },
      now: () => NOW
    })
    expect(result.map((task) => task.id)).toEqual(['t8'])
  })

  it('none due filter keeps tasks without a due date', () => {
    const noDue = makeTask({
      id: 't10',
      title: 'No due one',
      due: null,
      executors: [viewer]
    })
    const result = filterKanbanTasks({
      tasks: [executorTask, noDue],
      viewerId: viewer.id,
      filter: { role: 'executor', due: 'none' }
    })
    expect(result.map((task) => task.id)).toEqual(['t10'])
  })

  it('search matches title or id case-insensitively', () => {
    const result = filterKanbanTasks({
      tasks: ALL_TASKS,
      viewerId: viewer.id,
      filter: { role: 'executor', query: 'ALPHA' }
    })
    expect(result.map((task) => task.id)).toEqual(['t1'])
  })

  it('combines lane, due, urgent and search restrictions', () => {
    const combo = makeTask({
      id: 't11',
      title: 'Combo target',
      laneId: 'lane-open',
      laneName: 'Открыто',
      due: '2026-08-28',
      urgent: true,
      executors: [viewer]
    })
    const decoy = makeTask({
      id: 't12',
      title: 'Combo decoy',
      laneId: 'lane-open',
      laneName: 'Открыто',
      due: '2026-08-28',
      urgent: false,
      executors: [viewer]
    })
    const result = filterKanbanTasks({
      tasks: [combo, decoy],
      viewerId: viewer.id,
      filter: {
        role: 'executor',
        laneId: 'lane-open',
        due: 'week',
        urgent: true,
        query: 'combo'
      },
      now: () => NOW
    })
    expect(result.map((task) => task.id)).toEqual(['t11'])
  })
})

describe('sortKanbanTasks', () => {
  it('orders urgent first, then earliest due, then no due, then title', () => {
    const urgentLate = makeTask({
      id: 's1',
      title: 'Zebra urgent late',
      urgent: true,
      due: '2026-09-10',
      executors: [viewer]
    })
    const normalEarly = makeTask({
      id: 's2',
      title: 'Alpha early',
      urgent: false,
      due: '2026-08-25',
      executors: [viewer]
    })
    const normalLater = makeTask({
      id: 's3',
      title: 'Beta later',
      urgent: false,
      due: '2026-08-30',
      executors: [viewer]
    })
    const noDue = makeTask({
      id: 's4',
      title: 'Delta no due',
      urgent: false,
      due: null,
      executors: [viewer]
    })
    const sorted = sortKanbanTasks([normalLater, noDue, normalEarly, urgentLate])
    expect(sorted.map((task) => task.id)).toEqual(['s1', 's2', 's3', 's4'])
  })

  it('breaks equal dues on the locale-aware title', () => {
    const a = makeTask({ id: 's5', title: 'apple', due: '2026-08-28', executors: [viewer] })
    const b = makeTask({ id: 's6', title: 'Banana', due: '2026-08-28', executors: [viewer] })
    expect(sortKanbanTasks([b, a]).map((task) => task.id)).toEqual(['s5', 's6'])
  })

  it('does not mutate the input array', () => {
    const input = [executorTask, doneTask]
    const before = input.map((task) => task.id)
    sortKanbanTasks(input)
    expect(input.map((task) => task.id)).toEqual(before)
  })
})

describe('applyKanbanTaskFilterAndSort', () => {
  it('filters then sorts deterministically', () => {
    const urgentNoDue = makeTask({
      id: 'a1',
      title: 'Zulu urgent',
      urgent: true,
      due: null,
      executors: [viewer]
    })
    const calmEarly = makeTask({
      id: 'a2',
      title: 'Alpha calm',
      urgent: false,
      due: '2026-08-28',
      executors: [viewer]
    })
    const result = applyKanbanTaskFilterAndSort({
      tasks: [calmEarly, urgentNoDue],
      viewerId: viewer.id,
      filter: { role: 'executor' }
    })
    expect(result.map((task) => task.id)).toEqual(['a1', 'a2'])
  })
})

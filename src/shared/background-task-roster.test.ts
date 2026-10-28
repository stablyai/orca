import { describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTask } from './agent-session-wire'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import { sayBackgroundTaskEnglish as say } from './background-task-copy'
import { backgroundTasksHeaderContent as headerContent } from './background-task-header-content'
import {
  backgroundTaskCountedState as countedState,
  backgroundTaskRowMeta,
  backgroundTaskRowStopId,
  backgroundTasksStripTicks,
  buildBackgroundTaskGroups as buildGroups,
  buildBackgroundTaskGroupsFromViews,
  formatBackgroundTaskTokens,
  resolveBackgroundTaskName as resolveName,
  type BackgroundTaskGroup
} from './background-task-roster'

const buildBackgroundTaskGroups = (
  tasks: AgentSessionBackgroundTask[],
  settled: AgentSessionBackgroundTask[]
) => buildGroups(tasks, settled, say)
const backgroundTaskCountedState = (
  counted: string | number,
  state: Parameters<typeof countedState>[1]
) => countedState(counted, state, say)
const resolveBackgroundTaskName = (task: AgentSessionBackgroundTask) => resolveName(task, say)
const backgroundTasksHeaderContent = (
  groups: BackgroundTaskGroup[],
  options: { narrow: boolean; now: number }
) => headerContent(groups, options, say)

const NOW = 1_000_000

function agent(
  id: string,
  overrides: Partial<AgentSessionBackgroundTask> = {}
): AgentSessionBackgroundTask {
  return { id, kind: 'agent', state: 'working', startedAt: NOW - 60_000, ...overrides }
}

function header(
  tasks: AgentSessionBackgroundTask[],
  settled: AgentSessionBackgroundTask[] = [],
  narrow = false
) {
  return backgroundTasksHeaderContent(buildBackgroundTaskGroups(tasks, settled), {
    narrow,
    now: NOW
  })
}

describe('backgroundTasksHeaderContent', () => {
  it('lists all states for a single-kind fan-out (agents only)', () => {
    expect(header([agent('a'), agent('b'), agent('c', { state: 'waiting' })])).toEqual({
      segments: [{ text: '3 agents', kind: 'agent' }],
      detail: '2 working, 1 waiting'
    })
  })

  it('names a single working agent', () => {
    expect(header([agent('a')])).toEqual({
      segments: [{ text: '1 agent', kind: 'agent' }],
      detail: 'working'
    })
  })

  it('counts by kind for a mixed roster without a partial state breakdown', () => {
    expect(
      header([
        agent('a'),
        agent('b'),
        { id: 's', kind: 'command', state: 'working', startedAt: NOW },
        { id: 'm', kind: 'monitor', state: 'monitoring', startedAt: NOW }
      ])
    ).toEqual({
      segments: [
        { text: '2 agents', kind: 'agent' },
        { text: '1 shell', kind: 'command' },
        { text: '1 monitor', kind: 'monitor' }
      ],
      detail: null
    })
  })

  it('shows elapsed for a single shell command', () => {
    expect(
      header([{ id: 's', kind: 'command', state: 'working', startedAt: NOW - 72_000 }])
    ).toEqual({ segments: [{ text: '1 shell command', kind: 'command' }], detail: '1m 12s' })
  })

  it('leads with the attention state when a single agent needs the user', () => {
    expect(header([agent('a', { state: 'waiting' })])).toEqual({
      segments: [{ text: '1 agent waiting', kind: 'agent' }],
      detail: 'needs approval'
    })
  })

  it('reports lost contact above running work', () => {
    expect(
      header([agent('a', { state: 'unverifiable' }), agent('b', { state: 'unverifiable' })])
    ).toEqual({
      segments: [{ text: '2 agents with status unavailable', kind: 'agent' }],
      detail: null
    })
  })

  it('keeps the existing copy for a host that sends state without a task list', () => {
    expect(header([])).toEqual({ segments: [], detail: 'Monitoring background tasks' })
  })

  it('drops the breakdown for an honest total past the segment cap', () => {
    expect(
      header([
        agent('a'),
        { id: 'b', kind: 'command', state: 'working', startedAt: NOW },
        { id: 'c', kind: 'monitor', state: 'monitoring', startedAt: NOW },
        { id: 'd', kind: 'workflow', state: 'working', startedAt: NOW },
        agent('e'),
        { id: 'f', kind: 'command', state: 'working', startedAt: NOW },
        { id: 'g', kind: 'unknown', startedAt: NOW }
      ])
    ).toEqual({ segments: [{ text: '7 background tasks', kind: null }], detail: null })
  })

  it('totals a breakdown across kinds on a narrow strip', () => {
    expect(
      header([agent('a'), { id: 's', kind: 'command', state: 'working', startedAt: NOW }], [], true)
    ).toEqual({ segments: [{ text: '2 background tasks', kind: null }], detail: null })
  })

  it('keeps one kind in its state forms on a narrow strip', () => {
    // The attention state a reader must see survives the narrow width.
    expect(
      header([agent('a', { state: 'waiting' }), agent('b', { state: 'waiting' })], [], true)
    ).toEqual({ segments: [{ text: '2 agents waiting', kind: 'agent' }], detail: 'needs approval' })
    expect(header([agent('a'), agent('b', { state: 'waiting' })], [], true)).toEqual({
      segments: [{ text: '2 agents', kind: 'agent' }],
      detail: '1 working, 1 waiting'
    })
    expect(header([agent('a')], [], true)).toEqual({
      segments: [{ text: '1 agent', kind: 'agent' }],
      detail: 'working'
    })
  })

  it('says how many of the counted rows are done when every task has settled', () => {
    expect(
      header(
        [],
        [
          agent('a', { state: 'done' }),
          agent('b', { state: 'done' }),
          agent('c', { state: 'done' })
        ]
      )
    ).toEqual({ segments: [{ text: '3 agents', kind: 'agent' }], detail: '3 done' })
  })

  it('accounts for settled siblings so the breakdown sums to the count', () => {
    const content = header(
      [agent('live')],
      [
        agent('s1', { state: 'done' }),
        agent('s2', { state: 'done' }),
        agent('s3', { state: 'done' }),
        agent('s4', { state: 'done' })
      ]
    )
    expect(content).toEqual({
      segments: [{ text: '5 agents', kind: 'agent' }],
      detail: '1 working, 4 done'
    })
    // The headline count and its own breakdown must never contradict each other.
    const headline = Number(content.segments[0].text.split(' ')[0])
    const counted = (content.detail ?? '')
      .split(', ')
      .reduce((sum, part) => sum + Number(part.split(' ')[0]), 0)
    expect(counted).toBe(headline)
  })

  it('drops the elapsed clock from a settled shell command', () => {
    // The row already refuses a still-growing clock on finished work; so must the header.
    expect(
      header([], [{ id: 's', kind: 'command', state: 'done', startedAt: NOW - 72_000 }])
    ).toEqual({ segments: [{ text: '1 shell command', kind: 'command' }], detail: 'done' })
  })

  it('counts unknown tasks instead of hiding them', () => {
    expect(header([{ id: 'u', kind: 'unknown', startedAt: NOW }])).toEqual({
      segments: [{ text: '1 task', kind: 'unknown' }],
      detail: 'working'
    })
  })
})

describe('buildBackgroundTaskGroups', () => {
  it('groups by kind in fixed order, keeping first-seen order inside a group', () => {
    const built = buildBackgroundTaskGroups(
      [
        { id: 'm', kind: 'monitor', startedAt: 3 },
        agent('late', { startedAt: 2 }),
        agent('early', { startedAt: 1 })
      ],
      [agent('settled', { state: 'done', startedAt: 0 })]
    )
    expect(built.map((group) => group.kind)).toEqual(['agent', 'monitor'])
    expect(built[0].tasks.map((entry) => entry.row.id)).toEqual(['settled', 'early', 'late'])
    expect(built[0].tasks[0].row.settled).toBe(true)
  })

  it('defaults the state slot so a stateless row still reads as work', () => {
    const built = buildBackgroundTaskGroups([{ id: 'a', kind: 'agent' }], [])
    expect(built[0].tasks[0].state).toBe('working')
    const monitor = buildBackgroundTaskGroups([{ id: 'm', kind: 'monitor' }], [])
    expect(monitor[0].tasks[0].state).toBe('monitoring')
  })
})

describe('backgroundTaskCountedState', () => {
  it('words a count with each state as one sentence', () => {
    expect(backgroundTaskCountedState('2 agents', 'working')).toBe('2 agents working')
    expect(backgroundTaskCountedState('2 agents', 'monitoring')).toBe('2 agents monitoring')
    expect(backgroundTaskCountedState('2 agents', 'waiting')).toBe('2 agents waiting')
    expect(backgroundTaskCountedState('2 agents', 'blocked')).toBe('2 agents blocked')
    expect(backgroundTaskCountedState('2 agents', 'done')).toBe('2 agents done')
    expect(backgroundTaskCountedState(3, 'idle')).toBe('3 stopped')
    expect(backgroundTaskCountedState(3, 'unverifiable')).toBe('3 with status unavailable')
  })
})

describe('formatBackgroundTaskTokens', () => {
  it('renders compact token counts like the mock', () => {
    expect(formatBackgroundTaskTokens(950)).toBe('950')
    expect(formatBackgroundTaskTokens(18_130)).toBe('18.1k')
    expect(formatBackgroundTaskTokens(4_100)).toBe('4.1k')
    expect(formatBackgroundTaskTokens(2_000)).toBe('2k')
    expect(formatBackgroundTaskTokens(1_450_000)).toBe('1.5m')
    // Rounding first would promote this to "1000k".
    expect(formatBackgroundTaskTokens(999_950)).toBe('1m')
    expect(formatBackgroundTaskTokens(999_949)).toBe('999.9k')
  })
})

describe('resolveBackgroundTaskName', () => {
  it('prefers description, then name, then the kind label', () => {
    expect(
      resolveBackgroundTaskName({ id: 'a', kind: 'agent', description: 'review PR', name: 'deep' })
    ).toBe('review PR')
    expect(resolveBackgroundTaskName({ id: 'a', kind: 'agent', name: 'deep_review' })).toBe(
      'deep_review'
    )
    expect(resolveBackgroundTaskName({ id: 'a', kind: 'agent' })).toBe('Background agent')
  })

  it('rejects empty-after-trim and placeholder names', () => {
    expect(resolveBackgroundTaskName({ id: 'a', kind: 'agent', description: '   ' })).toBe(
      'Background agent'
    )
    expect(
      resolveBackgroundTaskName({
        id: 'a',
        kind: 'command',
        description: 'Unknown',
        name: ' task '
      })
    ).toBe('Background command')
  })
})

describe('resumed tasks from mixed-version hosts', () => {
  it('renders one live owner per id and counts only the two dispatched agents', () => {
    const live = agent('resumed', { totalTokens: 20000 })
    const settled = agent('resumed', { state: 'done', totalTokens: 19003 })
    const shells = Array.from({ length: 4 }, (_, index) =>
      agent(`shell-${index}`, { kind: 'command' })
    )
    const groups = buildBackgroundTaskGroups(
      [live, ...shells],
      [settled, agent('sibling', { state: 'done' })]
    )
    const owners = groups
      .flatMap((group) => group.tasks)
      .filter((entry) => entry.row.id === live.id)
    expect(owners).toHaveLength(1)
    expect(owners[0]).toMatchObject({
      row: {
        settled: false,
        displayState: 'working',
        name: 'Background agent',
        totalTokens: 20000
      },
      state: 'working'
    })
    expect(backgroundTasksHeaderContent(groups, { narrow: false, now: NOW }).segments).toEqual([
      { text: '2 agents', kind: 'agent' },
      { text: '4 shells', kind: 'command' }
    ])
  })
})

function view(id: string, overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id,
    providerId: `provider-${id}`,
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: NOW - 60_000,
    observedAt: NOW,
    stoppable: true,
    invocation: { invocationId: `spawn-${id}`, generation: 1 },
    ...overrides
  }
}

describe('backgroundTasksStripTicks', () => {
  it('ticks only while the list is open or the header times one live shell', () => {
    const agents = buildBackgroundTaskGroups([agent('a'), agent('b')], [])
    expect(backgroundTasksStripTicks(agents, false)).toBe(false)
    expect(backgroundTasksStripTicks(agents, true)).toBe(true)
    const shell = buildBackgroundTaskGroups(
      [{ id: 's', kind: 'command', state: 'working', startedAt: NOW }],
      []
    )
    expect(backgroundTasksStripTicks(shell, false)).toBe(true)
  })

  it('never wakes for finished work', () => {
    const settled = buildBackgroundTaskGroups([], [agent('a', { state: 'done' })])
    expect(backgroundTasksStripTicks(settled, true)).toBe(false)
  })
})

describe('background task row meta and Stop', () => {
  it('reads tokens then elapsed', () => {
    const [group] = buildBackgroundTaskGroups([agent('a', { totalTokens: 18_130 })], [])
    expect(backgroundTaskRowMeta(group.tasks[0].row, NOW)).toBe('18.1k · 1m 0s')
  })

  it('offers Stop only for a live row the host can target', () => {
    const [group] = buildBackgroundTaskGroupsFromViews([view('a'), view('b', { stoppable: false })])
    const [a, b] = group.tasks.map((entry) => entry.row)
    expect(backgroundTaskRowStopId(a, true)).toBe('provider-a')
    expect(backgroundTaskRowStopId(a, false)).toBeNull()
    expect(backgroundTaskRowStopId(b, true)).toBeNull()
  })
})

// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentSessionBackgroundTask } from '../../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import type { WorkerDockRowView } from './WorkerDockRow'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import { NativeChatWorkerDockFrame } from './NativeChatWorkerDockFrame'

afterEach(cleanup)

const LONG_COMMAND =
  'pnpm exec vitest run --config config/vitest.config.ts --maxWorkers=1 src/example/one.test.ts src/example/two.test.ts'

function command(id: string, description = `make target-${id}`): AgentSessionBackgroundTask {
  return { id, kind: 'command', description, state: 'working', startedAt: 10, stoppable: true }
}
function subagent(id: string): AgentSessionBackgroundTask {
  return { id, kind: 'agent', description: `Explore ${id}`, state: 'working', startedAt: 10 }
}
function worker(id: string, state: WorkerDockRowView['state'] = 'running'): WorkerDockRowView {
  return {
    id: `home/source/worker/${id}`,
    dispatchId: `attempt-${id}`,
    source: 'source',
    kind: 'worker',
    name: `Worker ${id}`,
    title: `Review change ${id}`,
    model: null,
    state,
    changedAt: 100,
    startedAt: 0,
    reason: null,
    settlement: state === 'failed' ? 'failed' : null,
    resultId: null,
    stoppable: true,
    ownerActionsAvailable: true
  }
}

type Props = ComponentProps<typeof NativeChatBackgroundTasksStatus>

function renderTray({
  tasks = [],
  workers = [],
  ...rest
}: { tasks?: AgentSessionBackgroundTask[]; workers?: WorkerDockRowView[] } & Partial<Props> = {}) {
  const props: Props = {
    tasks,
    settledTasks: [],
    supportsTaskStop: true,
    offersStopAll: false,
    stoppingTaskIds: new Set(),
    stoppingAll: false,
    indicatorActive: true,
    isVisible: true,
    expanded: false,
    onExpandedChange: () => {},
    onStop: () => {},
    sessionId: 'session-1',
    workerRows: new Map(workers.map((row) => [row.id, row])),
    workerIdentities: workers,
    ...rest
  }
  const view = render(
    <TooltipProvider>
      <NativeChatBackgroundTasksStatus {...props} />
    </TooltipProvider>
  )
  return {
    ...view,
    rerender: (next: Partial<Props>) =>
      view.rerender(
        <TooltipProvider>
          <NativeChatBackgroundTasksStatus {...props} {...next} />
        </TooltipProvider>
      )
  }
}

function chip(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-worker-dock-pill]')!
}

describe('worker tray counts only agents as workers', () => {
  it.each([
    // Agents alone read as what runs; with commands, the chip names the two counts apart.
    ['agents only', { workers: [worker('a'), worker('b')] }, '2 running', '2 running'],
    [
      'commands only',
      { tasks: [command('shell-1')] },
      '1 background command',
      '1 background command'
    ],
    [
      'agents and commands',
      { workers: [worker('a')], tasks: [subagent('sub-1'), command('shell-1')] },
      '2 workers · 1 command',
      '2 workers, 1 background command'
    ]
  ])('folded chip with %s', (_name, input, text, spoken) => {
    renderTray(input)
    expect(chip()).toHaveTextContent(text)
    expect(chip()).toHaveAccessibleName(expect.stringMatching(new RegExp(`^${spoken}, latest: `)))
  })

  it('draws nothing with no rows', () => {
    renderTray()
    expect(chip()).toBeNull()
  })

  it('reads all-failed from every listed row, commands included', () => {
    renderTray({ workers: [worker('a', 'failed')], tasks: [command('shell-1')] })
    // One failed worker beside a running command is not "1 failed".
    expect(chip()).toHaveTextContent('1 worker · 1 command')
    cleanup()
    renderTray({ workers: [worker('a', 'failed'), worker('b', 'failed')] })
    expect(chip()).toHaveTextContent('2 failed')
  })

  it('uses a terminal mark, not the worker grid, when only commands run', () => {
    renderTray({ tasks: [command('shell-1')] })
    expect(chip().querySelector('[data-worker-dock-terminal]')).not.toBeNull()
    expect(chip().querySelector('[data-worker-dock-dot-grid]')).toBeNull()
    cleanup()
    renderTray({ workers: [worker('a')], tasks: [command('shell-1')] })
    expect(chip().querySelector('[data-worker-dock-terminal]')).toBeNull()
  })
})

describe('open tray', () => {
  it.each([
    // The open header reads like the chip.
    ['agents only', { workers: [worker('a'), worker('b')] }, '2 running', 'Workers'],
    [
      'commands only',
      { tasks: [command('shell-1')] },
      '1 background command',
      'Background commands'
    ],
    [
      'agents and commands',
      { workers: [worker('a')], tasks: [command('shell-1')] },
      '1 worker · 1 command',
      'Workers and background commands'
    ]
  ])('header and region with %s', (_name, input, header, region) => {
    renderTray({ ...input, expanded: true })
    expect(chip()).toHaveTextContent(header)
    expect(screen.getByRole('region', { name: region })).toBeInTheDocument()
  })

  it('lists agents first, then the commands under their own group', () => {
    renderTray({
      expanded: true,
      workers: [worker('a')],
      tasks: [command('shell-1'), subagent('sub-1')]
    })
    const region = screen.getByRole('region', { name: 'Workers and background commands' })
    const workers = within(region).getByRole('group', { name: 'Workers' })
    const commands = within(region).getByRole('group', { name: 'Background commands' })
    const openers = [...workers.querySelectorAll('[data-worker-dock-open]')]
    expect(openers.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Review change a'),
      expect.stringContaining('Explore sub-1')
    ])
    expect(within(commands).getByText('make target-shell-1')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-worker-dock-group-label]')).toHaveLength(1)
  })

  it('draws no group label when only one group is listed', () => {
    renderTray({ expanded: true, tasks: [command('shell-1'), command('shell-2')] })
    expect(document.querySelector('[data-worker-dock-group-label]')).toBeNull()
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('keeps a new agent in the agents group while the card is held', () => {
    const view = renderTray({ expanded: true, workers: [worker('a')], tasks: [command('shell-1')] })
    const region = screen.getByRole('region', { name: 'Workers and background commands' })
    fireEvent.pointerEnter(region.parentElement!)
    view.rerender({ tasks: [command('shell-1'), subagent('sub-new')] })
    const workers = screen.getByRole('group', { name: 'Workers' })
    expect(within(workers).getByText('Explore sub-new')).toBeInTheDocument()
    const commands = screen.getByRole('group', { name: 'Background commands' })
    expect(within(commands).queryByText('Explore sub-new')).toBeNull()
  })

  it('names what Stop all stops when orchestration workers are listed', () => {
    const onStop = vi.fn()
    renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      onStop,
      workers: [worker('a')],
      tasks: [command('shell-1')]
    })
    // The stop names no target: it may end subagents that start before the tray updates.
    fireEvent.click(screen.getByRole('button', { name: 'Stop subagents and commands' }))
    expect(onStop).toHaveBeenCalledWith()
    cleanup()
    renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      workers: [worker('a')],
      tasks: [command('shell-1'), subagent('sub-1')]
    })
    expect(screen.getByRole('button', { name: 'Stop subagents and commands' })).toBeInTheDocument()
    cleanup()
    renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      tasks: [command('shell-1')]
    })
    expect(screen.getByRole('button', { name: 'Stop all' })).toBeInTheDocument()
  })

  it('keeps a command row to one line and reads a long command short', () => {
    renderTray({ expanded: true, tasks: [command('shell-1', LONG_COMMAND)] })
    const row = screen.getByRole('button', { name: /^pnpm exec vitest/ })
    expect(row.getAttribute('aria-label')!.split(' · ')[0].length).toBeLessThanOrEqual(60)
    expect(within(row).getByText(LONG_COMMAND)).toHaveClass('truncate', 'font-mono')
  })

  it('a command row keeps its Stop through the chat', () => {
    const onStop = vi.fn()
    renderTray({ expanded: true, onStop, workers: [worker('a')], tasks: [command('shell-1')] })
    fireEvent.click(screen.getByRole('button', { name: /^Stop .*make target-shell-1/ }))
    expect(onStop).toHaveBeenCalledWith('shell-1')
  })

  it('names subagents and commands beside workers whatever subagents or commands are listed', () => {
    renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      workers: [worker('a')],
      tasks: [subagent('sub-1')]
    })
    expect(screen.getByRole('button', { name: 'Stop subagents and commands' })).toBeInTheDocument()
    cleanup()
    renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      incomplete: true,
      workers: [worker('a')],
      tasks: [command('shell-1')]
    })
    expect(screen.getByRole('button', { name: 'Stop subagents and commands' })).toBeInTheDocument()
  })

  it('says Clear failed workers when a failed command Clear cannot remove stays behind', () => {
    const failedCommand: WorkerDockRowView = {
      ...worker('shell', 'failed'),
      kind: 'command',
      title: 'make check',
      settlement: null
    }
    renderTray({
      expanded: true,
      workers: [worker('a', 'failed'), worker('b', 'failed'), failedCommand]
    })
    expect(screen.getByRole('button', { name: /Clear all 2 failed workers/ })).toHaveTextContent(
      'Clear failed workers'
    )
    cleanup()
    renderTray({ expanded: true, workers: [worker('a', 'failed'), worker('b', 'failed')] })
    expect(screen.getByRole('button', { name: /Clear all 2 failed workers/ })).toHaveTextContent(
      /^Clear failed$/
    )
  })
})

describe('kinds', () => {
  it('lists a workflow with the background work, since its agents are listed on their own', () => {
    renderTray({
      workers: [worker('a')],
      tasks: [{ id: 'flow-1', kind: 'workflow', description: 'Release flow', state: 'working' }]
    })
    expect(chip()).toHaveTextContent('1 worker · 1 command')
  })

  it('opens a monitor’s run, not an agent view', () => {
    const details = vi.fn()
    const agent = vi.fn()
    renderTray({
      expanded: true,
      onShowProviderDetails: details,
      onShowAgent: agent,
      tasks: [{ id: 'watch-1', kind: 'monitor', description: 'Watch CI', state: 'monitoring' }]
    })
    fireEvent.click(screen.getByRole('button', { name: /^Watch CI/ }))
    expect(details).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'monitor' }),
      expect.anything()
    )
    expect(agent).not.toHaveBeenCalled()
  })

  it.each([
    ['a workflow', [{ id: 'flow-1', kind: 'workflow' as const, description: 'Release flow' }]],
    [
      'a workflow and a command',
      [{ id: 'flow-1', kind: 'workflow' as const, description: 'Release flow' }, command('shell-1')]
    ],
    ['nothing of its own (work it does not list)', []],
    ['an unclassified task', [{ id: 'task-1', kind: 'unknown' as const, description: 'Task' }]],
    [
      'an unclassified task and a command',
      [{ id: 'task-1', kind: 'unknown' as const, description: 'Task' }, command('shell-1')]
    ]
  ])('never understates Stop all beside workers with %s', (_name, tasks) => {
    renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      workers: [worker('a')],
      tasks: tasks.map((task) => ({ state: 'working' as const, ...task }))
    })
    const stop = screen.getByRole('button', { name: 'Stop subagents and commands' })
    expect(stop).toHaveAccessibleDescription('Workers keep running')
  })

  it('reads a long command short in its Stop and in the chip’s latest', () => {
    renderTray({ expanded: true, tasks: [command('shell-1', LONG_COMMAND)] })
    const stop = document.querySelector<HTMLElement>('[data-worker-dock-action]')!
    expect(stop.getAttribute('aria-label')).not.toContain(LONG_COMMAND)
    expect(stop.getAttribute('aria-label')).toContain('…')
    cleanup()
    renderTray({ tasks: [command('shell-1', LONG_COMMAND)] })
    const latest = chip().getAttribute('aria-label')!.split('latest: ')[1]
    expect(latest.length).toBeLessThanOrEqual(60)
  })

  it('names everything Stop all may end when the roster could not be read', () => {
    renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      unavailable: true,
      workers: [worker('a')],
      tasks: [command('shell-1')]
    })
    expect(screen.getByRole('button', { name: 'Stop subagents and commands' })).toBeInTheDocument()
  })

  it('names subagents and commands beside workers with only a monitor listed', () => {
    renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      workers: [worker('a')],
      tasks: [{ id: 'watch-1', kind: 'monitor', description: 'Watch CI', state: 'monitoring' }]
    })
    expect(screen.getByRole('button', { name: 'Stop subagents and commands' })).toBeInTheDocument()
  })

  it('hands focus to the pill when the footer Stop it held goes away', () => {
    const view = renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      workers: [worker('a')],
      tasks: [command('shell-1')]
    })
    screen.getByRole('button', { name: 'Stop subagents and commands' }).focus()
    view.rerender({ offersStopAll: false, tasks: [] })
    expect(document.activeElement).toBe(chip())
  })

  it('hands focus to the message box when the footer Stop goes with the whole card', () => {
    const w = worker('a')
    const props: Props = {
      tasks: [command('shell-1')],
      settledTasks: [],
      supportsTaskStop: false,
      offersStopAll: true,
      stoppingTaskIds: new Set(),
      stoppingAll: false,
      indicatorActive: true,
      isVisible: true,
      expanded: true,
      onExpandedChange: () => {},
      onStop: () => {},
      sessionId: 'session-1',
      workerRows: new Map([[w.id, w]]),
      workerIdentities: [w]
    }
    const pane = (next: Partial<Props>) => (
      <TooltipProvider>
        <div data-native-chat-root="">
          <NativeChatBackgroundTasksStatus {...props} {...next} />
          <textarea data-native-chat-prompt-editor="" aria-label="Message" />
        </div>
      </TooltipProvider>
    )
    const view = render(pane({}))
    screen.getByRole('button', { name: 'Stop subagents and commands' }).focus()
    // The chat's last work ends: no rows, nothing unlisted, so the card and its pill go too.
    view.rerender(pane({ tasks: [], workerRows: new Map(), workerIdentities: [] }))
    expect(chip()).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }))
  })

  it('leaves focus the user moved elsewhere when the footer Stop goes away', () => {
    const view = renderTray({
      expanded: true,
      supportsTaskStop: false,
      offersStopAll: true,
      workers: [worker('a')],
      tasks: [command('shell-1')]
    })
    screen.getByRole('button', { name: 'Stop subagents and commands' }).focus()
    const row = screen.getByRole('button', { name: /^Worker · Review change a/ })
    row.focus()
    view.rerender({ offersStopAll: false, tasks: [] })
    expect(document.activeElement).toBe(row)
  })

  it('keeps focus on the same row when a second group appears or leaves', () => {
    const view = renderTray({ expanded: true, workers: [worker('a')] })
    const opener = screen.getByRole('button', { name: /^Review change a/ })
    opener.focus()
    view.rerender({ tasks: [command('shell-1')] })
    expect(opener.isConnected).toBe(true)
    expect(document.activeElement).toBe(opener)
    view.rerender({ tasks: [] })
    expect(opener.isConnected).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('keeps focus on a command row when the first worker arrives', () => {
    const view = renderTray({ expanded: true, tasks: [command('shell-1')] })
    const opener = screen.getByRole('button', { name: /^make target-shell-1/ })
    opener.focus()
    const arriving = worker('a')
    view.rerender({
      workerRows: new Map([[arriving.id, arriving]]),
      workerIdentities: [arriving]
    })
    expect(opener.isConnected).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('keeps focus on a command row’s Stop when the last worker leaves', () => {
    const view = renderTray({ expanded: true, workers: [worker('a')], tasks: [command('shell-1')] })
    const stop = screen.getByRole('button', { name: /^Stop .*make target-shell-1/ })
    stop.focus()
    view.rerender({ workerRows: new Map(), workerIdentities: [] })
    expect(stop.isConnected).toBe(true)
    expect(document.activeElement).toBe(stop)
  })

  function heldTray(initial: Partial<Props>) {
    const props: Props = {
      tasks: [],
      settledTasks: [],
      supportsTaskStop: true,
      offersStopAll: false,
      stoppingTaskIds: new Set(),
      stoppingAll: false,
      indicatorActive: true,
      isVisible: true,
      expanded: false,
      onExpandedChange: () => {},
      onStop: () => {},
      sessionId: 'session-1',
      ...initial
    }
    const tray = (next: Partial<Props>) => (
      <TooltipProvider>
        <NativeChatWorkerDockFrame>
          <NativeChatBackgroundTasksStatus {...props} {...next} />
        </NativeChatWorkerDockFrame>
      </TooltipProvider>
    )
    const view = render(tray({}))
    return {
      // A press starts on the card: its structure holds until the press ends.
      holdThen: (next: Partial<Props>) => {
        fireEvent.pointerDown(chip(), { button: 0, pointerId: 1 })
        view.rerender(tray(next))
      }
    }
  }

  it('keeps naming a held commands-only card by its rows while the live roster empties', () => {
    heldTray({ tasks: [command('shell-1')], expanded: true }).holdThen({ tasks: [] })
    expect(chip()).toHaveTextContent(/^1 background command/)
    expect(screen.getByRole('region', { name: 'Background commands' })).toBeInTheDocument()
  })

  it('keeps a held folded commands-only chip’s terminal mark and name', () => {
    heldTray({ tasks: [command('shell-1')] }).holdThen({ tasks: [] })
    expect(chip()).toHaveTextContent('1 background command')
    expect(chip().querySelector('[data-worker-dock-terminal]')).not.toBeNull()
    expect(chip()).toHaveAccessibleName(/^1 background command, latest: /)
  })

  it('keeps a held mixed chip’s full spoken count', () => {
    const w = worker('a')
    heldTray({
      tasks: [command('shell-1')],
      workerRows: new Map([[w.id, w]]),
      workerIdentities: [w]
    }).holdThen({ tasks: [], workerRows: new Map(), workerIdentities: [] })
    expect(chip()).toHaveTextContent('1 worker · 1 command')
    expect(chip()).toHaveAccessibleName(/^1 worker, 1 background command, latest: /)
  })

  it('keeps a held all-failed chip saying what failed', () => {
    const a = worker('a', 'failed')
    const b = worker('b', 'failed')
    heldTray({
      workerRows: new Map([
        [a.id, a],
        [b.id, b]
      ]),
      workerIdentities: [a, b]
    }).holdThen({ workerRows: new Map(), workerIdentities: [] })
    expect(chip()).toHaveTextContent('2 workers')
  })
})

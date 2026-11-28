// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkerDockElsewhereEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'
import type { WorkerDockRowView } from './WorkerDockRow'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import { NativeChatWorkerDockFrame } from './NativeChatWorkerDockFrame'

afterEach(cleanup)

function worker(id: string): WorkerDockRowView {
  return {
    id: `home/source/worker/${id}`,
    dispatchId: `attempt-${id}`,
    source: 'source',
    kind: 'worker',
    name: `Worker ${id}`,
    title: `Review change ${id}`,
    model: null,
    state: 'running',
    changedAt: 100,
    startedAt: 0,
    reason: null,
    settlement: null,
    resultId: null,
    stoppable: true,
    ownerActionsAvailable: true
  }
}
function chat(source: string, running: number, title?: string): WorkerDockElsewhereEntry {
  return {
    source,
    sessionId: `${source}-live`,
    workspaceId: 'ws',
    running,
    ...(title ? { title } : {})
  }
}

type Props = ComponentProps<typeof NativeChatBackgroundTasksStatus>
function renderTray(input: { workers?: WorkerDockRowView[] } & Partial<Props> = {}) {
  const { workers = [], ...rest } = input
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
    workerRows: new Map(workers.map((row) => [row.id, row])),
    workerIdentities: workers,
    ...rest
  }
  const tree = (next: Partial<Props> = {}) => (
    <TooltipProvider>
      <NativeChatBackgroundTasksStatus {...props} {...next} />
    </TooltipProvider>
  )
  const view = render(tree())
  return { ...view, rerender: (next: Partial<Props>) => view.rerender(tree(next)) }
}
const chip = () => document.querySelector<HTMLElement>('[data-worker-dock-pill]')!
const elsewhereRows = () => [
  ...document.querySelectorAll<HTMLElement>('[data-worker-dock-row^="elsewhere:"]')
]
const open = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-worker-dock-open]')!

describe('Other chats in the worker island', () => {
  it('draws the island for work running only in other chats, with a running chip that names it', () => {
    renderTray({ elsewhere: [chat('b', 25, 'Hourly release scan')] })
    expect(chip()).toHaveTextContent('25 elsewhere')
    expect(chip()).toHaveAccessibleName('25 workers running in other chats')
    expect(chip().querySelector('[data-worker-dock-glyph="running"], svg')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('25 workers running in other chats')
  })

  it('adds the other chats’ count after this chat’s own, in the chip and its spoken name', () => {
    renderTray({ workers: [worker('a'), worker('b')], elsewhere: [chat('b', 25)] })
    expect(chip()).toHaveTextContent('2 running · +25')
    expect(chip()).toHaveAccessibleName(
      expect.stringMatching(/^2 running, 25 more running in other chats, latest: /)
    )
  })

  it('draws today’s island when no other chat runs anything', () => {
    renderTray({ elsewhere: [] })
    expect(chip()).toBeFalsy()
  })

  it('lists one read-only row per chat that opens that chat; a blank name reads as Untitled chat', () => {
    const onOpenElsewhere = vi.fn()
    renderTray({
      expanded: true,
      workers: [worker('a')],
      elsewhere: [chat('b', 25, 'Hourly release scan'), chat('c', 3, '   ')],
      onOpenElsewhere
    })
    const group = screen.getByRole('group', { name: 'Other chats' })
    const rows = elsewhereRows()
    expect(rows.map((row) => row.textContent)).toEqual(['Hourly release scan25', 'Untitled chat3'])
    expect(open(rows[0]!)).toHaveAccessibleName('Hourly release scan, 25 running, opens chat')
    // Nothing to stop or clear from here: those stay with the chat that started the workers.
    expect(within(group).queryByRole('button', { name: /stop|clear/i })).toBeNull()
    fireEvent.click(open(rows[1]!))
    expect(onOpenElsewhere).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'c', sessionId: 'c-live' }),
      expect.any(HTMLElement)
    )
  })

  it('shows four chats whole, and three plus “+N more chats” from five', () => {
    const { rerender } = renderTray({
      expanded: true,
      elsewhere: ['a', 'b', 'c', 'd'].map((id) => chat(id, 1, `Chat ${id}`))
    })
    expect(elsewhereRows()).toHaveLength(4)
    expect(screen.queryByText(/more chats/)).toBeNull()
    rerender({ elsewhere: ['a', 'b', 'c', 'd', 'e'].map((id) => chat(id, 1, `Chat ${id}`)) })
    expect(elsewhereRows()).toHaveLength(3)
    expect(screen.getByText('+2 more chats')).toBeInTheDocument()
    expect(chip()).toHaveTextContent('5 elsewhere')
  })

  it('walks from the chip into the Other chats rows with the arrows, with no rows of its own', () => {
    renderTray({ expanded: true, elsewhere: [chat('b', 2, 'Scan'), chat('c', 1, 'Docs')] })
    const [first, second] = elsewhereRows()
    chip().focus()
    fireEvent.keyDown(chip(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(open(first!))
    fireEvent.keyDown(open(first!), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(open(second!))
    fireEvent.keyDown(open(second!), { key: 'ArrowUp' })
    fireEvent.keyDown(open(first!), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(chip())
  })

  it('walks on from this chat’s own last row into the Other chats rows', () => {
    renderTray({ expanded: true, workers: [worker('a')], elsewhere: [chat('b', 2, 'Scan')] })
    const own = document.querySelector<HTMLElement>(
      '[data-worker-dock-row="home/source/worker/a"] [data-worker-dock-open]'
    )!
    own.focus()
    fireEvent.keyDown(own, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(open(elsewhereRows()[0]!))
  })

  it('hands focus to the next row when the focused Other chats row leaves', async () => {
    const { rerender } = renderTray({
      expanded: true,
      elsewhere: [chat('b', 2, 'Scan'), chat('c', 1, 'Docs')]
    })
    const leaving = open(elsewhereRows()[0]!)
    act(() => leaving.focus())
    rerender({ expanded: true, elsewhere: [chat('c', 1, 'Docs')] })
    expect(document.activeElement).toBe(open(elsewhereRows()[0]!))
  })

  it('hands focus to this chat’s own row when the last Other chats row leaves', () => {
    const { rerender } = renderTray({
      expanded: true,
      workers: [worker('z')],
      elsewhere: [chat('c', 1, 'Docs')]
    })
    act(() => open(elsewhereRows()[0]!).focus())
    const z = worker('z')
    rerender({
      expanded: true,
      workerRows: new Map([[z.id, z]]),
      workerIdentities: [z],
      elsewhere: []
    })
    expect(document.activeElement).toBe(
      document.querySelector(
        '[data-worker-dock-row="home/source/worker/z"] [data-worker-dock-open]'
      )
    )
  })

  it('holds the Other chats rows still while a press on the card is in progress', () => {
    const props = {
      tasks: [],
      settledTasks: [],
      supportsTaskStop: true,
      offersStopAll: false,
      stoppingTaskIds: new Set<string>(),
      stoppingAll: false,
      indicatorActive: true,
      isVisible: true,
      expanded: true,
      onExpandedChange: () => {},
      onStop: () => {},
      sessionId: 'session-1'
    }
    const tray = (elsewhere: WorkerDockElsewhereEntry[]) => (
      <TooltipProvider>
        <NativeChatWorkerDockFrame>
          <NativeChatBackgroundTasksStatus {...props} elsewhere={elsewhere} />
        </NativeChatWorkerDockFrame>
      </TooltipProvider>
    )
    const view = render(tray([chat('b', 2, 'Scan'), chat('c', 1, 'Docs')]))
    fireEvent.pointerDown(open(elsewhereRows()[0]!), { button: 0, pointerId: 1 })
    view.rerender(tray([chat('c', 1, 'Docs')]))
    expect(elsewhereRows().map((row) => row.textContent)).toEqual(['Scan2', 'Docs1'])
  })
})

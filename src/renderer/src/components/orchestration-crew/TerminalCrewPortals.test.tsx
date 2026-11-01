// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PtyTransport } from '../terminal-pane/pty-transport-types'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createIpcPtyTransport } from '../terminal-pane/pty-transport'
import { TerminalCrewPortals } from './TerminalCrewPortals'
import { holdPhysicalCloseTasks } from './crew-menu.test-fixture'

const rig = vi.hoisted(() => ({ open: vi.fn(), copy: vi.fn() }))
vi.mock('./use-terminal-crew-identity', () => ({
  useTerminalCrewIdentity: (paneKey: string) => ({ target: { kind: 'local' }, party: paneKey })
}))
vi.mock('../native-chat/use-orchestration-crew', () => ({
  useOrchestrationCrew: () => ({
    ...emptyCrew('ok'),
    sections: { managedBy: [], managing: [currentWorker], talkingWith: [] }
  })
}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: rig.open }))
vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const worker: OrchestrationCrewRow = {
  partyKey: 'worker',
  role: 'worker',
  label: 'Worker',
  agentKind: 'codex',
  status: 'working',
  sendAddress: 'dispatch:worker',
  openTarget: { kind: 'terminal', handle: 'term_worker' },
  latest: {
    direction: 'from',
    preview: 'Keep this disclosure',
    at: '2026-10-30T00:00:00Z',
    sequence: 1
  }
}
let currentWorker = worker
type Controller = ComponentProps<typeof TerminalCrewPortals>['controller']
const managers = new Set<PaneManager>()
const ipcTransports: ReturnType<typeof createIpcPtyTransport>[] = []
function resetFixture() {
  cleanup()
  for (const transport of ipcTransports.splice(0)) {
    transport.destroy?.()
  }
  for (const manager of managers) {
    manager.destroy()
  }
  managers.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(useAppStore.getInitialState(), true)
}
afterEach(() => {
  resetFixture()
  vi.clearAllMocks()
})

function mount(insertion?: {
  acceptance: boolean | Promise<boolean> | undefined
  split?: boolean
}) {
  currentWorker = insertion
    ? { ...worker, task: { title: 'Inspect', state: 'dispatched' }, sendAddress: 'term_worker' }
    : worker
  if (insertion) {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  }
  const root = document.createElement('div')
  document.body.appendChild(root)
  const manager = new PaneManager(root, { linkOpenHint: () => '' })
  managers.add(manager)
  const first = manager.createInitialPane(
    insertion ? { focus: false, leafId: '11111111-1111-4111-8111-111111111111' } : undefined
  )
  const second = insertion && !insertion.split ? first : manager.splitPane(first.id, 'vertical')
  if (!second) {
    throw new Error('fixture split failed')
  }
  const panes = insertion && !insertion.split ? [first] : [first, second]
  const input = document.createElement('textarea')
  const secondInput = document.createElement('textarea')
  input.value = 'existing suffix'
  input.setSelectionRange(8, 8)
  const sendInput = vi.fn(() => true)
  const accepted = vi.fn(async () => insertion?.acceptance ?? true)
  const transport: PtyTransport = {
    connect: vi.fn(),
    attach: vi.fn(),
    disconnect: vi.fn(),
    sendInputImmediate: vi.fn(() => true),
    resize: vi.fn(() => true),
    getPtyId: () => 'pty-captured',
    isConnected: () => true,
    sendInput,
    ...(insertion?.acceptance === undefined ? {} : { sendInputAccepted: accepted })
  }
  const transports = new Map(
    panes.map((pane) => {
      if (insertion) {
        return [pane.id, transport] as const
      }
      const ipc = createIpcPtyTransport()
      ipcTransports.push(ipc)
      return [pane.id, ipc] as const
    })
  )
  if (insertion) {
    first.container.append(input)
    vi.spyOn(first.terminal, 'focus').mockImplementation(() => input.focus())
    if (insertion.split) {
      second.container.append(secondInput)
      vi.spyOn(second.terminal, 'focus').mockImplementation(() => secondInput.focus())
    }
    manager.setActivePane(first.id, { focus: false })
    vi.spyOn(manager, 'setActivePane')
  }
  const controller: Controller = {
    tabId: insertion ? 'tab' : 'retained-tab',
    worktreeId: insertion ? 'workspace' : 'worktree',
    managerRef: { current: manager },
    paneTransportsRef: { current: transports },
    managedPanes: panes,
    effectiveChatViewMode: false,
    chatPane: null,
    isRendererVisible: true,
    expandedPaneId: null,
    isolatedPaneKey: null
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeTerminalClipboardText: rig.copy } }
  })
  rig.copy.mockResolvedValue(undefined)
  const content = () => (
    <TooltipProvider>
      <TerminalCrewPortals controller={controller} />
    </TooltipProvider>
  )
  const view = render(content())
  return {
    controller,
    first,
    second,
    manager,
    input,
    secondInput,
    transport,
    transports,
    accepted,
    sendInput,
    update: () => view.rerender(content())
  }
}
function fixture(acceptance: boolean | Promise<boolean> | undefined, split = false) {
  const test = mount({ acceptance, split })
  const pane = test.first
  fireEvent.click(within(pane.container).getByRole('button', { name: 'Show crew: 1 workers' }))
  return {
    ...test,
    pane,
    more: within(pane.container).getByRole('button', { name: 'More for Worker' }),
    mention: () =>
      fireEvent.click(within(pane.container).getByRole('button', { name: 'Mention all' }))
  }
}

it.each(['row', 'all', 'menu'] as const)(
  'focuses captured input at the pointer and keyboard %s press before pending paste, keeping the panel open',
  async (route) => {
    for (const method of ['pointer', 'keyboard'] as const) {
      const tasks = holdPhysicalCloseTasks()
      const user = userEvent.setup()
      const delivery = Promise.withResolvers<boolean>()
      const test = fixture(delivery.promise, true)
      const pane = within(test.pane.container)
      test.accepted.mockImplementationOnce(async () => {
        expect(test.input).toHaveFocus()
        expect(test.manager.getActivePane()?.id).toBe(test.pane.id)
        return delivery.promise
      })
      const button =
        route === 'row'
          ? pane.getByRole('button', { name: 'Codex Worker Inspect' })
          : route === 'all'
            ? pane.getByRole('button', { name: 'Mention all' })
            : test.more
      if (method === 'keyboard') {
        act(() => button.focus())
        await user.keyboard('{Enter}')
      } else {
        await user.click(button)
      }
      if (route === 'menu') {
        const item = screen.getByRole('menuitem', { name: 'Mention in message' })
        if (method === 'keyboard') {
          await waitFor(() => expect(item).toHaveFocus())
          await user.keyboard('{Enter}')
        } else {
          await user.click(item)
        }
      }
      expect(test.accepted).toHaveBeenCalledExactlyOnceWith(
        'Worker (Orca agent term_worker) ',
        'driving'
      )
      expect(test.input).toHaveFocus()
      expect(pane.getByRole('button', { name: 'Collapse crew panel' })).toBeInTheDocument()
      const returned = vi.spyOn(test.more, 'focus')
      if (route === 'menu') {
        expect(tasks).toHaveLength(1)
        act(tasks[0])
        expect(returned).not.toHaveBeenCalled()
        expect(test.input).toHaveFocus()
      }
      vi.mocked(test.manager.setActivePane).mockClear()
      await act(async () => delivery.resolve(true))
      expect(test.manager.setActivePane).not.toHaveBeenCalled()
      expect(test.input).toHaveFocus()
      expect(test.input.value).toBe('existing suffix')
      expect(test.input.selectionStart).toBe(8)
      expect(test.sendInput).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      resetFixture()
      vi.clearAllMocks()
    }
  }
)

it('does not focus or activate after ACK over a later pointer choice of another pane', async () => {
  const tasks = holdPhysicalCloseTasks()
  const user = userEvent.setup()
  const delivery = Promise.withResolvers<boolean>()
  const test = fixture(delivery.promise, true)
  await user.click(test.more)
  await user.click(screen.getByRole('menuitem', { name: 'Mention in message' }))
  expect(test.input).toHaveFocus()
  fireEvent.pointerDown(test.second.container)
  const destination = document.activeElement
  act(tasks[0])
  expect(document.activeElement).toBe(destination)
  vi.mocked(test.manager.setActivePane).mockClear()
  const focus = vi.mocked(test.pane.terminal.focus)
  focus.mockClear()
  await act(async () => delivery.resolve(false))
  expect(test.manager.setActivePane).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(destination)
  expect(test.accepted).toHaveBeenCalledExactlyOnceWith(
    'Worker (Orca agent term_worker) ',
    'driving'
  )
  expect(test.sendInput).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledOnce()
})

it('focuses the captured pane before acceptance, preserves caret/no Enter, and uses the legacy input fallback', async () => {
  for (const acceptance of [true, undefined]) {
    const test = fixture(acceptance)
    expect(document.activeElement).not.toBe(test.input)
    await act(async () => test.mention())
    expect(test.manager.setActivePane).toHaveBeenCalledExactlyOnceWith(test.pane.id, {
      focus: false
    })
    expect(document.activeElement).toBe(test.input)
    expect(test.input.selectionStart).toBe(8)
    expect(test.input.value).toBe('existing suffix')
    const writer = acceptance === undefined ? test.sendInput : test.accepted
    expect(writer).toHaveBeenCalledExactlyOnceWith('Worker (Orca agent term_worker) ', 'driving')
    expect(toast.error).not.toHaveBeenCalled()
    resetFixture()
    vi.clearAllMocks()
  }
})

it.each(['pane', 'transport'] as const)(
  'refuses an invocation with a stale %s without focusing or writing to a replacement',
  async (kind) => {
    const test = fixture(true)
    if (kind === 'pane') {
      test.manager.createInitialPane({ focus: false })
      test.manager.retirePanePreservingPty(test.pane.id)
    } else {
      test.transports.set(test.pane.id, { ...test.transport })
    }
    vi.mocked(test.manager.setActivePane).mockClear()
    const focus = vi.mocked(test.pane.terminal.focus)
    focus.mockClear()
    await act(async () => test.mention())
    expect(test.accepted).not.toHaveBeenCalled()
    expect(test.sendInput).not.toHaveBeenCalled()
    expect(test.manager.setActivePane).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'The terminal did not accept the agent reference. Try again.'
    )
  }
)

it('retires only the hidden menu before deferred physical close and never replays it on show', async () => {
  const tasks = holdPhysicalCloseTasks()
  const user = userEvent.setup()
  const { controller, first, update } = mount()
  const pane = within(first.container)
  await user.click(pane.getByRole('button', { name: 'Show crew: 1 workers' }))
  const disclosure = pane.getByRole('button', { name: "Show Worker's task and latest message" })
  await user.click(disclosure)
  const oldMore = pane.getByRole('button', { name: 'More for Worker' })
  await user.click(oldMore)
  const firstPopup = screen.getByRole('menu')
  const oldFocus = vi.spyOn(oldMore, 'focus')
  act(() => {
    controller.isRendererVisible = false
    update()
  })
  expect(firstPopup.isConnected).toBe(false)
  expect(oldMore.isConnected).toBe(false)
  expect(tasks).toHaveLength(1)
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(pane.getByText('Keep this disclosure')).toBeInTheDocument()
  expect(pane.getByRole('button', { name: 'Collapse crew panel' })).toBeInTheDocument()
  act(() => {
    controller.isRendererVisible = true
    update()
  })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  const more = pane.getByRole('button', { name: 'More for Worker' })
  expect(more).toHaveAttribute('aria-expanded', 'false')
  await user.click(more)
  const secondPopup = screen.getByRole('menu')
  await user.keyboard('{Escape}')
  expect(secondPopup.isConnected).toBe(false)
  expect(tasks).toHaveLength(2)
  const focus = vi.spyOn(more, 'focus')
  act(tasks[0])
  expect(oldFocus).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  act(tasks[1])
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  expect(more).toHaveFocus()
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await user.click(pane.getByRole('button', { name: 'Open Worker' }))
  expect(rig.open).toHaveBeenCalledExactlyOnceWith(worker, { kind: 'local' })
  await user.click(more)
  await user.click(screen.getByRole('menuitem', { name: 'Open its chat' }))
  expect(rig.open).toHaveBeenCalledTimes(2)
  expect(rig.open).toHaveBeenLastCalledWith(worker, { kind: 'local' })
  expect(rig.copy).not.toHaveBeenCalled()
})

it('uses numeric expansion and exact activity leaf identity without dismissing another visible split', async () => {
  const user = userEvent.setup()
  const { controller, first, second, manager, update } = mount()
  const a = within(first.container)
  const b = within(second.container)
  await user.click(a.getByRole('button', { name: 'Show crew: 1 workers' }))
  await user.click(b.getByRole('button', { name: 'Show crew: 1 workers' }))
  await user.click(a.getByRole('button', { name: 'More for Worker' }))
  const popup = screen.getByRole('menu')
  // Existing overlay focus preservation allows a visible split to remain open when another is active.
  manager.setActivePane(second.id)
  expect(manager.getActivePane()?.id).toBe(second.id)
  act(update)
  expect(screen.getByRole('menu')).toBe(popup)
  act(() => {
    controller.expandedPaneId = second.id
    update()
  })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(a.queryByRole('button', { name: 'More for Worker' })).not.toBeInTheDocument()
  expect(b.getByRole('button', { name: 'More for Worker' })).toBeInTheDocument()
  act(() => {
    controller.expandedPaneId = null
    update()
  })
  await user.click(a.getByRole('button', { name: 'More for Worker' }))
  act(() => {
    controller.isolatedPaneKey = makePaneKey(controller.tabId, second.leafId)
    update()
  })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(a.queryByRole('button', { name: 'More for Worker' })).not.toBeInTheDocument()
  await user.click(b.getByRole('button', { name: 'More for Worker' }))
  act(() => {
    controller.isolatedPaneKey = makePaneKey('other-tab', second.leafId)
    update()
  })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(b.queryByRole('button', { name: 'More for Worker' })).not.toBeInTheDocument()
  act(() => {
    controller.isolatedPaneKey = null
    update()
  })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(rig.open).not.toHaveBeenCalled()
  expect(rig.copy).not.toHaveBeenCalled()
})

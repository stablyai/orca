// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type * as RuntimeGraph from '@/runtime/sync-runtime-graph'
import type * as OpenAgentMessageSender from '@/lib/open-agent-message-sender'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PtyTransport } from '../terminal-pane/pty-transport-types'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createIpcPtyTransport } from '../terminal-pane/pty-transport'
import { TerminalCrewPortals } from './TerminalCrewPortals'
import { FOCUS_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import { handleFocusTerminalPaneDetail } from '../terminal-pane/focus-terminal-pane-event'
import { holdPhysicalCloseTasks } from './crew-menu.test-fixture'
import {
  retainedCrewSurfaces,
  selectConfiguredNextPane
} from './terminal-crew-selection.test-fixture'

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
vi.mock('../tab-bar/TabBar', () => ({ default: () => null }))
vi.mock('../editor/EditorPanel', () => ({
  default: () => <textarea aria-label="Other editor input" />
}))
vi.mock('@/runtime/sync-runtime-graph', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeGraph>()),
  observeTabGroupBodyGridSize: () => () => {}
}))

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
const disposeSurfaces: (() => void)[] = []
function resetFixture() {
  cleanup()
  disposeSurfaces.splice(0).forEach((dispose) => dispose())
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
  retained?: 'terminal' | 'editor' | 'agent-session'
}) {
  currentWorker = insertion
    ? { ...worker, task: { title: 'Inspect', state: 'dispatched' }, sendAddress: 'term_worker' }
    : worker
  let ptyId = 'pty-captured'
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
    getPtyId: () => ptyId,
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
  const retained = insertion?.retained ? retainedCrewSurfaces(root, insertion.retained) : undefined
  if (retained) {
    disposeSurfaces.push(retained.dispose)
  }
  const content = () => (
    <TooltipProvider>
      {retained ? (
        retained.wrap(<TerminalCrewPortals controller={controller} />)
      ) : (
        <TerminalCrewPortals controller={controller} />
      )}
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
    retained,
    update: () => view.rerender(content()),
    replacePty: () => {
      ptyId = 'pty-replaced'
    }
  }
}
function fixture(
  acceptance: boolean | Promise<boolean> | undefined,
  split = false,
  retained?: 'terminal' | 'editor' | 'agent-session'
) {
  const test = mount({ acceptance, split, retained })
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
          ? pane.getByRole('button', { name: 'Codex working Worker Inspect' })
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

it.each(['pointer', 'keyboard', 'open', 'floating'] as const)(
  'does not focus or activate after ACK over a later %s choice',
  async (choice) => {
    const tasks = holdPhysicalCloseTasks()
    const user = userEvent.setup()
    const delivery = Promise.withResolvers<boolean>()
    const test = fixture(delivery.promise, true)
    await user.click(test.more)
    await user.click(screen.getByRole('menuitem', { name: 'Mention in message' }))
    expect(test.input).toHaveFocus()
    if (choice === 'pointer') {
      fireEvent.pointerDown(test.second.container)
    } else if (choice === 'keyboard') {
      selectConfiguredNextPane(test.controller, test.manager)
    } else if (choice === 'open') {
      const sender = await vi.importActual<typeof OpenAgentMessageSender>(
        '@/lib/open-agent-message-sender'
      )
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        frames.push(callback)
      )
      useAppStore.setState({
        activeWorktreeId: 'workspace',
        tabsByWorktree: {
          workspace: [
            {
              id: 'tab',
              ptyId: null,
              worktreeId: 'workspace',
              title: 'Terminals',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab: {
            root: { type: 'leaf', leafId: test.second.leafId },
            activeLeafId: test.second.leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [test.second.leafId]: 'term_worker' }
          }
        }
      })
      const receive = (event: Event) => {
        if (event instanceof CustomEvent) {
          const detail: unknown = event.detail
          if (
            !detail ||
            typeof detail !== 'object' ||
            !('tabId' in detail) ||
            typeof detail.tabId !== 'string' ||
            !('leafId' in detail) ||
            typeof detail.leafId !== 'string'
          ) {
            throw new Error('Invalid production focus event')
          }
          handleFocusTerminalPaneDetail(
            { tabId: detail.tabId, leafId: detail.leafId },
            {
              tabId: 'tab',
              manager: test.manager,
              acknowledgeAgents: vi.fn(),
              surfaceStaleAgentRow: vi.fn()
            }
          )
        }
      }
      window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, receive)
      disposeSurfaces.push(() => window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, receive))
      rig.open.mockImplementationOnce(sender.openOrchestrationCrewAgent)
      await user.click(within(test.pane.container).getByRole('button', { name: 'Open Worker' }))
      expect(rig.open).toHaveBeenCalledExactlyOnceWith(currentWorker, { kind: 'local' })
      act(() => frames.splice(0).forEach((frame) => frame(0)))
      expect(test.secondInput).toHaveFocus()
      expect(test.manager.getActivePane()?.id).toBe(test.second.id)
    } else {
      const destination = document.createElement('textarea')
      destination.setAttribute('aria-label', 'Floating input')
      document.body.append(destination)
      destination.focus()
    }
    const destination = document.activeElement
    act(tasks[0])
    expect(document.activeElement).toBe(destination)
    vi.mocked(test.manager.setActivePane).mockClear()
    const focus = vi.mocked(test.pane.terminal.focus)
    focus.mockClear()
    await act(async () => {
      if (choice === 'floating') {
        delivery.reject(new Error('paste failed'))
      } else {
        delivery.resolve(choice !== 'pointer')
      }
    })
    expect(test.manager.setActivePane).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(destination)
    expect(test.accepted).toHaveBeenCalledExactlyOnceWith(
      'Worker (Orca agent term_worker) ',
      'driving'
    )
    expect(test.sendInput).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(choice === 'pointer' || choice === 'floating' ? 1 : 0)
  }
)

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

it('shows one refusal toast and never focuses replaced captured pane, PTY or transport after an asynchronous write', async () => {
  for (const rejects of [false, true]) {
    const refused = fixture(false)
    if (rejects) {
      refused.accepted.mockRejectedValueOnce(new Error('transport rejected'))
    }
    await act(async () => refused.mention())
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(refused.manager.setActivePane).toHaveBeenCalledExactlyOnceWith(refused.pane.id, {
      focus: false
    })
    expect(refused.input).toHaveFocus()
    resetFixture()
    vi.clearAllMocks()
  }
  for (const kind of ['pane', 'pty', 'transport', 'manager'] as const) {
    let finish!: (accepted: boolean) => void
    const test = fixture(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    act(() => test.mention())
    expect(test.input).toHaveFocus()
    vi.mocked(test.manager.setActivePane).mockClear()
    if (kind === 'pane') {
      const replacement = test.manager.createInitialPane({
        focus: false,
        leafId: '22222222-2222-4222-8222-222222222222'
      })
      expect(test.manager.retirePanePreservingPty(test.pane.id)).toBe(true)
      expect(test.manager.getPanes()).toEqual([replacement])
    }
    if (kind === 'pty') {
      test.replacePty()
    }
    if (kind === 'transport') {
      test.transports.set(test.pane.id, { ...test.transport })
    }
    if (kind === 'manager') {
      const root = document.createElement('div')
      document.body.append(root)
      const replacement = new PaneManager(root, { linkOpenHint: () => '' })
      managers.add(replacement)
      replacement.createInitialPane({ focus: false })
      test.controller.managerRef.current = replacement
    }
    await act(async () => finish(true))
    expect(test.manager.setActivePane).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(test.accepted).toHaveBeenCalledTimes(1)
    resetFixture()
    vi.clearAllMocks()
  }
})

it.each(['pane', 'pty', 'transport', 'disconnected', 'detached'] as const)(
  'refuses an invocation with a stale %s without focusing or writing to a replacement',
  async (kind) => {
    const test = fixture(true)
    if (kind === 'pane') {
      test.manager.createInitialPane({ focus: false })
      test.manager.retirePanePreservingPty(test.pane.id)
    } else if (kind === 'pty') {
      test.replacePty()
    } else if (kind === 'transport') {
      test.transports.set(test.pane.id, { ...test.transport })
    } else if (kind === 'disconnected') {
      vi.spyOn(test.transport, 'isConnected').mockReturnValue(false)
    } else {
      test.pane.container.remove()
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

it('keeps accepted real menu Mention on the captured terminal across close and pending delivery', async () => {
  for (const pending of [false, true]) {
    const user = userEvent.setup()
    const delivery = Promise.withResolvers<boolean>()
    const test = fixture(pending ? delivery.promise : true)
    await user.click(test.more)
    expect(test.manager.setActivePane).toHaveBeenCalledExactlyOnceWith(test.pane.id, {
      focus: false
    })
    expect(document.activeElement).not.toBe(test.input)
    vi.mocked(test.manager.setActivePane).mockClear()
    const popup = within(document.body).getByRole('menu')
    const closed = vi.fn()
    popup.addEventListener('focusScope.autoFocusOnUnmount', closed)
    const returned = vi.spyOn(test.more, 'focus')
    await user.click(within(document.body).getByRole('menuitem', { name: 'Mention in message' }))
    await waitFor(() => expect(within(document.body).queryByRole('menu')).toBeNull())
    await waitFor(() => expect(closed).toHaveBeenCalledOnce())
    expect(closed.mock.calls[0][0].target).toBe(popup)
    if (pending) {
      expect(test.input).toHaveFocus()
      returned.mockClear()
      await act(async () => delivery.resolve(true))
    }
    await waitFor(() => expect(document.activeElement).toBe(test.input))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(returned).not.toHaveBeenCalled()
    expect(test.manager.setActivePane).toHaveBeenCalledExactlyOnceWith(test.pane.id, {
      focus: false
    })
    expect(test.accepted).toHaveBeenCalledExactlyOnceWith(
      'Worker (Orca agent term_worker) ',
      'driving'
    )
    expect(test.sendInput).not.toHaveBeenCalled()
    expect(test.input.selectionStart).toBe(8)
    expect(test.input.value).toBe('existing suffix')
    expect(toast.error).not.toHaveBeenCalled()
    resetFixture()
    vi.clearAllMocks()
  }
})

it('dismisses real menu Mention without inventing delivery on refusal, rejection or captured transport replacement', async () => {
  for (const outcome of ['refused', 'rejected', 'replaced-before', 'replaced-after'] as const) {
    const user = userEvent.setup()
    const delivery = Promise.withResolvers<boolean>()
    const test = fixture(delivery.promise)
    await user.click(test.more)
    expect(test.manager.setActivePane).toHaveBeenCalledExactlyOnceWith(test.pane.id, {
      focus: false
    })
    expect(document.activeElement).not.toBe(test.input)
    vi.mocked(test.manager.setActivePane).mockClear()
    if (outcome === 'replaced-before') {
      test.transports.set(test.pane.id, { ...test.transport })
    }
    await user.click(within(document.body).getByRole('menuitem', { name: 'Mention in message' }))
    await waitFor(() => expect(within(document.body).queryByRole('menu')).toBeNull())
    await waitFor(() =>
      expect(document.activeElement).toBe(outcome === 'replaced-before' ? test.more : test.input)
    )
    const focusCalls = vi.mocked(test.manager.setActivePane).mock.calls.length
    vi.mocked(test.manager.setActivePane).mockClear()
    if (outcome === 'replaced-after') {
      test.transports.set(test.pane.id, { ...test.transport })
    }
    await act(async () => {
      if (outcome === 'rejected') {
        delivery.reject(new Error('transport rejected'))
      } else {
        delivery.resolve(outcome === 'replaced-before' || outcome === 'replaced-after')
      }
    })
    expect(test.manager.setActivePane).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(outcome === 'replaced-before' ? test.more : test.input)
    expect(focusCalls).toBe(outcome === 'replaced-before' ? 0 : 1)
    if (outcome === 'replaced-before') {
      expect(test.accepted).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        'The terminal did not accept the agent reference. Try again.'
      )
      await act(async () => test.mention())
      expect(test.accepted).not.toHaveBeenCalled()
      expect(test.manager.setActivePane).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledTimes(2)
      expect(vi.mocked(toast.error).mock.calls[1]).toEqual(vi.mocked(toast.error).mock.calls[0])
    } else {
      expect(test.accepted).toHaveBeenCalledExactlyOnceWith(
        'Worker (Orca agent term_worker) ',
        'driving'
      )
      expect(toast.error).toHaveBeenCalledTimes(outcome === 'replaced-after' ? 0 : 1)
    }
    expect(test.sendInput).not.toHaveBeenCalled()
    expect(test.input.value).toBe('existing suffix')
    resetFixture()
    vi.clearAllMocks()
  }
})

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

it.each(['terminal', 'editor', 'agent-session'] as const)(
  'keeps exact retained %s group selection from pointer and keyboard/AT entry while A stays current',
  async (kind) => {
    for (const entry of ['pointer', 'focus'] as const) {
      const user = userEvent.setup()
      const delivery = Promise.withResolvers<boolean>()
      const test = fixture(delivery.promise, false, kind)
      await user.click(test.more)
      await user.click(screen.getByRole('menuitem', { name: 'Mention in message' }))
      await waitFor(() => expect(test.input).toHaveFocus())
      const destination =
        kind === 'editor'
          ? await screen.findByRole('textbox', { name: 'Other editor input' })
          : test.retained!.otherInput
      expect(test.retained!.otherPane.id).toBe(test.pane.id)
      if (entry === 'pointer') {
        fireEvent.pointerDown(destination)
      } else {
        act(() => destination.focus())
      }
      const state = useAppStore.getState()
      expect(state.activeGroupIdByWorktree.workspace).toBe('other')
      expect(
        state.groupsByWorktree.workspace.find((group) => group.id === 'other')?.activeTabId
      ).toBe('other-tab')
      expect(
        state.unifiedTabsByWorktree.workspace.find((tab) => tab.id === 'other-tab')
      ).toMatchObject({ entityId: 'other-content', contentType: kind })
      expect(test.manager.getActivePane()?.id).toBe(test.pane.id)
      vi.mocked(test.manager.setActivePane).mockClear()
      await act(async () => delivery.resolve(true))
      expect(test.manager.setActivePane).not.toHaveBeenCalled()
      expect(useAppStore.getState().activeGroupIdByWorktree.workspace).toBe('other')
      expect(test.manager.getActivePane()?.id).toBe(test.pane.id)
      if (entry === 'focus') {
        expect(destination).toHaveFocus()
      }
      expect(test.accepted).toHaveBeenCalledExactlyOnceWith(
        'Worker (Orca agent term_worker) ',
        'driving'
      )
      expect(test.sendInput).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      resetFixture()
      vi.clearAllMocks()
    }
  }
)

it('keeps ordinary retained menu press focus in A through physical close and acceptance', async () => {
  const user = userEvent.setup()
  const delivery = Promise.withResolvers<boolean>()
  const test = fixture(delivery.promise, false, 'terminal')
  await user.click(test.more)
  await user.click(screen.getByRole('menuitem', { name: 'Mention in message' }))
  await waitFor(() => expect(test.input).toHaveFocus())
  expect(useAppStore.getState().activeGroupIdByWorktree.workspace).toBe('source')
  vi.mocked(test.manager.setActivePane).mockClear()
  await act(async () => delivery.resolve(true))
  expect(test.manager.setActivePane).not.toHaveBeenCalled()
  expect(test.input).toHaveFocus()
})

// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  initialStore,
  resetSenderStore
} from '../native-chat/native-chat-agent-sender.test-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
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
    sections: { managedBy: [], managing: [worker], talkingWith: [] }
  })
}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: rig.open }))
// happy-dom has no canvas; actual PaneManager identity/layout does not need xterm opened.
vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})
const { PaneManager } = await import('@/lib/pane-manager/pane-manager')

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
type Controller = ComponentProps<typeof TerminalCrewPortals>['controller']
const managers: InstanceType<typeof PaneManager>[] = []
const transports: ReturnType<typeof createIpcPtyTransport>[] = []
const roots: HTMLElement[] = []
function mount() {
  const root = document.createElement('div')
  document.body.appendChild(root)
  roots.push(root)
  const manager = new PaneManager(root, { linkOpenHint: () => '' })
  managers.push(manager)
  const first = manager.createInitialPane()
  const second = manager.splitPane(first.id, 'vertical')
  if (!second) {
    throw new Error('fixture split failed')
  }
  const panes = [first, second]
  const controller: Controller = {
    tabId: 'retained-tab',
    worktreeId: 'worktree',
    paneTransportsRef: {
      current: new Map(
        panes.map((pane) => {
          const transport = createIpcPtyTransport()
          transports.push(transport)
          return [pane.id, transport]
        })
      )
    },
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
  return { controller, first, second, manager, update: () => view.rerender(content()) }
}
beforeEach(() => {
  resetSenderStore()
})
afterEach(() => {
  cleanup()
  for (const transport of transports.splice(0)) {
    transport.destroy?.()
  }
  for (const manager of managers.splice(0)) {
    manager.destroy()
  }
  for (const root of roots.splice(0)) {
    root.remove()
  }
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('retires only the hidden menu before deferred physical close and never replays it on show', async () => {
  const tasks = holdPhysicalCloseTasks()
  const user = userEvent.setup()
  const { controller, first, update } = mount()
  const pane = within(first.container)
  await user.click(pane.getByRole('button', { name: 'Show crew: 1 workers' }))
  const disclosure = pane.getByRole('button', { name: /Worker No shared task/ })
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

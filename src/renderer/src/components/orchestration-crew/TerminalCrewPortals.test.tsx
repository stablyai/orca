// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store/index'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PtyTransport } from '../terminal-pane/pty-transport/pty-transport-types'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { createIpcPtyTransport } from '../terminal-pane/pty-transport/ipc/pty-transport'
import { TerminalCrewPortals } from './TerminalCrewPortals'

// Exercise dormant panel interactions independently of the suspension gate.
vi.mock('./use-orchestration-panel-enabled', () => ({
  useOrchestrationPanelEnabled: () => true
}))
const rig = vi.hoisted(() => ({ open: vi.fn(), copy: vi.fn(), identity: vi.fn(), crew: vi.fn() }))
vi.mock('./use-terminal-crew-identity', () => ({
  useTerminalCrewIdentity: (paneKey: string) => {
    rig.identity(paneKey)
    return { target: { kind: 'local' }, party: paneKey }
  }
}))
vi.mock('../native-chat/use-orchestration-crew', () => ({
  useOrchestrationCrew: () => {
    rig.crew()
    return {
      ...emptyCrew('ok'),
      sections: { managedBy: [], managing: [currentWorker], talkingWith: [] }
    }
  }
}))
// Render the real panel synchronously; the lazy chunk boundary is the app's load detail.
vi.mock('./LazyOrchestrationCrewPanel', async () => ({
  LazyOrchestrationCrewPanel: (await import('./OrchestrationCrewPanel')).OrchestrationCrewPanel
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
  restored?: boolean
}) {
  const link = { connected: !insertion?.restored }
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
    getPtyId: () => (link.connected ? 'pty-captured' : null),
    isConnected: () => link.connected,
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
    link,
    accepted,
    sendInput,
    update: () => view.rerender(content())
  }
}

it('mentions into a restored pane whose terminal connects after the panel first rendered', async () => {
  const test = mount({ acceptance: true, restored: true })
  fireEvent.click(
    within(test.first.container).getByRole('button', { name: /^Show orchestration: 1 worker,/ })
  )
  // The transport binds without any React update, as a restored pane's reattach does.
  test.link.connected = true
  await act(async () =>
    fireEvent.click(within(test.first.container).getByRole('button', { name: 'Mention all' }))
  )
  expect(test.accepted).toHaveBeenCalledExactlyOnceWith(
    'Worker (Orca agent term_worker) ',
    'driving'
  )
})

it('uses numeric expansion and exact activity leaf identity without dismissing another visible split', async () => {
  const user = userEvent.setup()
  const { controller, first, second, manager, update } = mount()
  const a = within(first.container)
  const b = within(second.container)
  await user.click(a.getByRole('button', { name: /^Show orchestration: 1 worker,/ }))
  await user.click(b.getByRole('button', { name: /^Show orchestration: 1 worker,/ }))
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

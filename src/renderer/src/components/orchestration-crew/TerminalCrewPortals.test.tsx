// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, within, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../terminal-pane/pty-transport-types'
import { emptyCrew } from '../../../../shared/orchestration-crew'
import { TooltipProvider } from '../ui/tooltip'
import { TerminalCrewPortals } from './TerminalCrewPortals'

vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ terminalLayoutsByTabId: {} })
}))
vi.mock('./use-terminal-crew-identity', () => ({
  useTerminalCrewIdentity: () => ({ target: { kind: 'local' }, party: 'term_self' })
}))
vi.mock('../native-chat/use-orchestration-crew', () => ({
  useOrchestrationCrew: () => {
    const snapshot = emptyCrew('ok')
    snapshot.sections.managing.push({
      partyKey: 'worker',
      role: 'worker',
      label: 'Worker',
      agentKind: 'codex',
      status: 'working',
      task: { title: 'Inspect', state: 'dispatched' },
      sendAddress: 'term_worker'
    })
    return snapshot
  }
}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const managers = new Set<PaneManager>()
function resetFixture() {
  cleanup()
  for (const manager of managers) {
    manager.destroy()
  }
  managers.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
}
afterEach(() => {
  resetFixture()
  vi.clearAllMocks()
})

function fixture(acceptance: boolean | Promise<boolean> | undefined) {
  let ptyId = 'pty-captured'
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const root = document.createElement('div')
  document.body.append(root)
  const manager = new PaneManager(root, { linkOpenHint: () => '' })
  managers.add(manager)
  const pane = manager.createInitialPane({
    focus: false,
    leafId: '11111111-1111-4111-8111-111111111111'
  })
  const container = pane.container
  const input = document.createElement('textarea')
  input.value = 'existing suffix'
  input.setSelectionRange(8, 8)
  container.append(input)
  const sendInput = vi.fn(() => true)
  const accepted = vi.fn(async () => acceptance ?? true)
  const transport: PtyTransport = {
    connect: vi.fn(),
    attach: vi.fn(),
    disconnect: vi.fn(),
    sendInputImmediate: vi.fn(() => true),
    resize: vi.fn(() => true),
    getPtyId: () => ptyId,
    isConnected: () => true,
    sendInput,
    ...(acceptance === undefined ? {} : { sendInputAccepted: accepted })
  }
  const transports = new Map([[pane.id, transport]])
  vi.spyOn(manager, 'setActivePane').mockImplementation((id, options) => {
    if (id === pane.id && options?.focus !== false) {
      input.focus()
    }
  })
  const controller = {
    tabId: 'tab',
    worktreeId: 'workspace',
    managerRef: { current: manager },
    paneTransportsRef: { current: transports },
    managedPanes: [pane],
    effectiveChatViewMode: false,
    chatPane: null
  }
  render(
    <TooltipProvider>
      <TerminalCrewPortals controller={controller} />
    </TooltipProvider>
  )
  fireEvent.click(within(container).getByRole('button', { name: 'Show crew: 1 workers' }))
  const mention = () =>
    fireEvent.click(within(container).getByRole('button', { name: 'Mention all' }))
  return {
    pane,
    input,
    mention,
    more: within(container).getByRole('button', { name: 'More for Worker' }),
    manager,
    transports,
    transport,
    accepted,
    sendInput,
    replacePty: () => {
      ptyId = 'pty-replaced'
    }
  }
}

it('restores the captured pane focus after acceptance, preserves caret/no Enter, and uses the legacy input fallback', async () => {
  for (const acceptance of [true, undefined]) {
    const test = fixture(acceptance)
    expect(document.activeElement).not.toBe(test.input)
    await act(async () => test.mention())
    expect(test.manager.setActivePane).toHaveBeenCalledExactlyOnceWith(test.pane.id)
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
    expect(refused.manager.setActivePane).not.toHaveBeenCalled()
    resetFixture()
    vi.clearAllMocks()
  }
  for (const kind of ['pane', 'pty', 'transport'] as const) {
    let finish!: (accepted: boolean) => void
    const test = fixture(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    act(() => test.mention())
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
    await act(async () => finish(true))
    expect(test.manager.setActivePane).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(test.accepted).toHaveBeenCalledTimes(1)
    resetFixture()
    vi.clearAllMocks()
  }
})

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
      await waitFor(() => expect(document.activeElement).toBe(test.more))
      expect(test.manager.setActivePane).not.toHaveBeenCalled()
      returned.mockClear()
      await act(async () => delivery.resolve(true))
    }
    await waitFor(() => expect(document.activeElement).toBe(test.input))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(returned).not.toHaveBeenCalled()
    expect(test.manager.setActivePane).toHaveBeenCalledExactlyOnceWith(test.pane.id)
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
    await waitFor(() => expect(document.activeElement).toBe(test.more))
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
    expect(document.activeElement).toBe(test.more)
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

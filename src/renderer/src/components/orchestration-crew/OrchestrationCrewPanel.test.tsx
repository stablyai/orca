// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { OrchestrationCrewPanel } from './OrchestrationCrewPanel'

const rig = vi.hoisted(() => ({
  snapshot: {},
  open: vi.fn(),
  copy: vi.fn(),
  success: vi.fn(),
  mention: vi.fn()
}))
vi.mock('../native-chat/use-orchestration-crew', () => ({
  useOrchestrationCrew: () => rig.snapshot
}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: rig.open }))
vi.mock('sonner', () => ({ toast: { success: rig.success } }))
const host = { kind: 'environment', environmentId: 'captured-host' } as const
const worker: OrchestrationCrewRow = {
  partyKey: 'worker',
  role: 'worker',
  label: 'Worker',
  agentKind: 'codex',
  status: 'working',
  sendAddress: 'dispatch:d1',
  openTarget: { kind: 'terminal', handle: 'term_captured' },
  task: { title: 'Check the result', state: 'active' },
  latest: {
    direction: 'from',
    preview: 'The result is ready.',
    at: '2026-10-28T00:00:00Z',
    sequence: 1
  }
}
function mount(row = worker, section: 'managing' | 'talkingWith' = 'managing', canMention = false) {
  rig.snapshot = {
    ...emptyCrew('ok'),
    sections: {
      managedBy: [],
      managing: section === 'managing' ? [row] : [],
      talkingWith: section === 'talkingWith' ? [row] : []
    }
  }
  rig.copy.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeTerminalClipboardText: rig.copy } }
  })
  return render(
    <TooltipProvider>
      <fieldset data-testid="crew-fieldset">
        <div className="pane" data-testid="crew-pane">
          <OrchestrationCrewPanel
            target={host}
            party="term_coordinator"
            canMention={canMention}
            mention={rig.mention}
          />
        </div>
      </fieldset>
    </TooltipProvider>
  )
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('keeps disabled/enabled mentions, keyboard disclosure, Open, Copy, Escape and collapse independent', async () => {
  const user = userEvent.setup()
  const view = mount()
  const tab = screen.getByRole('button', { name: 'Show crew: 1 workers' })
  tab.focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Collapse crew panel' })).toHaveFocus()
  expect(screen.getByText('Orchestration')).toBeInTheDocument()
  const body = screen.getByRole('button', { name: /Worker Check the result/ })
  const chevron = screen.getByRole('button', { name: "Show Worker's task and latest message" })
  expect(body).toBeDisabled()
  expect(body).not.toHaveAttribute('aria-expanded')
  expect(screen.getByRole('button', { name: 'Mention all' })).toBeDisabled()
  await user.click(body)
  expect(rig.mention).not.toHaveBeenCalled()
  expect(chevron).toHaveAttribute('aria-expanded', 'false')
  chevron.focus()
  await user.keyboard(' ')
  expect(chevron).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('The result is ready.')).toBeInTheDocument()
  expect(rig.open).not.toHaveBeenCalled()
  expect(rig.copy).not.toHaveBeenCalled()
  await user.click(chevron)
  expect(chevron).toHaveAttribute('aria-expanded', 'false')
  view.rerender(
    <TooltipProvider>
      <fieldset data-testid="crew-fieldset">
        <div className="pane" data-testid="crew-pane">
          <OrchestrationCrewPanel
            target={host}
            party="term_coordinator"
            canMention
            mention={rig.mention}
          />
        </div>
      </fieldset>
    </TooltipProvider>
  )
  expect(body).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Mention all' })).toBeEnabled()
  body.focus()
  await user.keyboard(' ')
  expect(rig.mention).toHaveBeenCalledExactlyOnceWith([worker])
  expect(chevron).toHaveAttribute('aria-expanded', 'false')
  await user.click(chevron)
  await user.click(body)
  expect(rig.mention).toHaveBeenCalledTimes(2)
  expect(rig.mention).toHaveBeenLastCalledWith([worker])
  expect(chevron).toHaveAttribute('aria-expanded', 'true')
  const open = screen.getByRole('button', { name: 'Open Worker' })
  open.focus()
  await user.keyboard('{Enter}')
  expect(rig.open).toHaveBeenCalledExactlyOnceWith(worker, host)
  expect(chevron).toHaveAttribute('aria-expanded', 'true')
  await user.click(screen.getByRole('button', { name: 'More for Worker' }))
  await user.click(screen.getByRole('menuitem', { name: 'Copy address' }))
  expect(rig.copy).toHaveBeenCalledExactlyOnceWith('dispatch:d1')
  expect(rig.success).toHaveBeenCalledExactlyOnceWith("Copied Worker's address")
  expect(rig.open).toHaveBeenCalledOnce()
  expect(chevron).toHaveAttribute('aria-expanded', 'true')
  await user.click(screen.getByRole('button', { name: 'More for Worker' }))
  const menuOpen = screen.getByRole('menuitem', { name: 'Open its chat' })
  menuOpen.focus()
  await user.keyboard('{Enter}')
  expect(rig.open).toHaveBeenCalledTimes(2)
  expect(rig.open).toHaveBeenLastCalledWith(worker, host)
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  expect(chevron).toHaveAttribute('aria-expanded', 'true')
  screen.getByRole('button', { name: 'Collapse crew panel' }).focus()
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Collapse crew panel')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  expect(screen.getByRole('complementary', { name: 'Agent crew' })).toBeInTheDocument()
  body.focus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('complementary', { name: 'Agent crew' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Show crew: 1 workers' })).toHaveFocus()
  await user.keyboard('{Enter}')
  await user.click(screen.getByRole('button', { name: 'Collapse crew panel' }))
  expect(screen.getByRole('button', { name: 'Show crew: 1 workers' })).toHaveFocus()
  expect(rig.copy).toHaveBeenCalledOnce()
})

it('starts pending questions expanded without navigating or copying', async () => {
  const user = userEvent.setup()
  mount({ ...worker, pendingQuestion: { preview: 'Which option?', at: '2026-10-28T01:00:00Z' } })
  await user.click(screen.getByRole('button', { name: 'Show crew: 1 workers' }))
  expect(screen.getByText('Asks you')).toBeInTheDocument()
  expect(screen.getByText('Which option?')).toBeInTheDocument()
  expect(screen.queryByText('The result is ready.')).not.toBeInTheDocument()
  expect(rig.open).not.toHaveBeenCalled()
  expect(rig.copy).not.toHaveBeenCalled()
})

it('keeps the stable first manager label, names the Orchestration disclosure and expands every manager', async () => {
  const user = userEvent.setup()
  const first = {
    ...worker,
    role: 'manager' as const,
    partyKey: 'host-a:manager',
    label: 'First manager'
  }
  const second = {
    ...worker,
    role: 'manager' as const,
    partyKey: 'host-b:manager',
    label: 'Other manager'
  }
  rig.snapshot = {
    ...emptyCrew('ok'),
    sections: { managedBy: [first, second], managing: [], talkingWith: [] }
  }
  render(
    <TooltipProvider delayDuration={0}>
      <OrchestrationCrewPanel
        target={host}
        party="term_worker"
        canMention={false}
        mention={rig.mention}
      />
    </TooltipProvider>
  )
  const tab = screen.getByRole('button', { name: 'Show crew: Managed by First manager' })
  await user.hover(tab)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Orchestration')
  await user.click(tab)
  expect(screen.getByRole('region', { name: 'Managed by' })).toHaveTextContent('First manager')
  expect(screen.getByRole('region', { name: 'Managed by' })).toHaveTextContent('Other manager')
})

it('shows one collapsed avatar and question per party with reverse-role relationships while keeping both sections', async () => {
  const user = userEvent.setup()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const question = { preview: 'Which option?', at: '2026-10-28T01:00:00Z' }
    const manager = { ...worker, role: 'manager' as const, pendingQuestion: question }
    const reverseWorker = { ...worker, pendingQuestion: question }
    const peer = { ...worker, partyKey: 'other-worker', label: 'Other worker' }
    rig.snapshot = {
      ...emptyCrew('ok'),
      sections: { managedBy: [manager], managing: [reverseWorker, peer], talkingWith: [] }
    }
    render(
      <TooltipProvider delayDuration={0}>
        <OrchestrationCrewPanel
          target={host}
          party="term_coordinator"
          canMention={false}
          mention={rig.mention}
        />
      </TooltipProvider>
    )
    const tab = screen.getByRole('button', { name: 'Show crew: 2 workers' })
    expect(tab.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2)
    expect(error).not.toHaveBeenCalled()
    expect(within(tab).getByText('1')).toBeInTheDocument()
    await user.click(tab)
    expect(screen.getByRole('region', { name: 'Managed by' })).toHaveTextContent('Worker')
    expect(screen.getByRole('region', { name: 'Managing' })).toHaveTextContent('Worker')
  } finally {
    error.mockRestore()
  }
})

it('retains an unavailable peer’s Open/latest/disclosure with one reason and unavailable Copy', async () => {
  const user = userEvent.setup()
  const { sendAddress, ...peer } = { ...worker, role: 'peer' as const, hostLabel: 'Remote host' }
  expect(sendAddress).toBe('dispatch:d1')
  mount(peer, 'talkingWith', true)
  await user.click(screen.getByRole('button', { name: 'Show crew: Talking with Worker' }))
  expect(screen.getAllByText('Sending unavailable')).toHaveLength(1)
  const body = screen.getByRole('button', { name: /Worker Check the result/ })
  expect(body).toBeDisabled()
  await user.click(body)
  expect(rig.mention).not.toHaveBeenCalled()
  expect(body).not.toHaveAttribute('aria-expanded')
  const chevron = screen.getByRole('button', { name: "Show Worker's task and latest message" })
  await user.click(chevron)
  expect(chevron).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('The result is ready.')).toBeInTheDocument()
  expect(screen.getAllByText('Sending unavailable')).toHaveLength(1)
  await user.hover(screen.getByRole('img', { name: 'Codex · Remote host' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Codex · Remote host')
  expect(screen.queryByText('codex')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Open Worker' }))
  expect(rig.open).toHaveBeenCalledExactlyOnceWith(peer, host)
  await user.click(screen.getByRole('button', { name: 'More for Worker' }))
  expect(screen.getByRole('menuitem', { name: 'Mention in message' })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  const copy = screen.getByRole('menuitem', { name: 'Copy address' })
  expect(copy).toHaveAttribute('aria-disabled', 'true')
  await user.click(copy)
  expect(rig.copy).not.toHaveBeenCalled()
  expect(screen.getAllByText('Sending unavailable')).toHaveLength(1)
})

it.each(['working', 'waiting', 'done'] as const)(
  'uses the shared %s indicator in the tab and row',
  async (status) => {
    const user = userEvent.setup()
    mount({ ...worker, status })
    const tab = screen.getByRole('button', { name: 'Show crew: 1 workers' })
    const indicator = tab.querySelector(`[aria-label="${status}"]`)
    expect(indicator).toBeInTheDocument()
    const glyph = indicator?.innerHTML
    if (status === 'working') {
      expect(indicator?.querySelector('[data-agent-spinner]')).toBeInTheDocument()
    } else if (status === 'waiting') {
      expect(indicator?.querySelector('.text-agent-question')).toBeInTheDocument()
    } else {
      expect(indicator?.querySelector('.bg-emerald-500')).toBeInTheDocument()
    }
    await user.click(tab)
    const panel = screen.getByRole('complementary', { name: 'Agent crew' })
    expect(panel.querySelector(`[aria-label="${status}"]`)?.innerHTML).toBe(glyph)
    expect(screen.queryByText('Sending unavailable')).not.toBeInTheDocument()
  }
)

it.each(['pointer', 'keyboard'] as const)(
  'returns to the actual invoker after %s opening, then collapses on the next Escape',
  async (opening) => {
    const user = userEvent.setup()
    mount()
    const other = render(
      <TooltipProvider>
        <div data-native-chat-root>
          <OrchestrationCrewPanel
            target={host}
            party="term_other"
            canMention={false}
            mention={rig.mention}
          />
          <input aria-label="Other pane" />
        </div>
      </TooltipProvider>
    )
    const pane = within(screen.getByTestId('crew-pane'))
    const otherPane = within(other.container)
    await user.click(otherPane.getByRole('button', { name: 'Show crew: 1 workers' }))
    await user.click(pane.getByRole('button', { name: 'Show crew: 1 workers' }))
    const more = pane.getByRole('button', { name: 'More for Worker' })
    if (opening === 'pointer') {
      await user.click(more)
    } else {
      more.focus()
      await user.keyboard('{ArrowDown}')
    }
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(more).toHaveFocus())
    expect(pane.getByRole('complementary')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(pane.queryByRole('complementary')).not.toBeInTheDocument()
    expect(pane.getByRole('button', { name: 'Show crew: 1 workers' })).toHaveFocus()
    expect(otherPane.getByRole('complementary')).toBeInTheDocument()
    expect(otherPane.getByRole('textbox')).not.toHaveFocus()
  }
)

function holdPhysicalCloseTasks() {
  const tasks: (() => void)[] = []
  const timer = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    // Observe the installed FocusScope cleanup task; never invoke the consumer callback directly.
    if (callback.toString().includes('unmountEvent')) {
      tasks.push(() => callback(...args))
      return timer(() => {}, 0)
    }
    return timer(callback, delay, ...args)
  })
  return tasks
}
async function showMenu() {
  const user = userEvent.setup()
  const view = mount()
  await user.click(screen.getByRole('button', { name: 'Show crew: 1 workers' }))
  const more = screen.getByRole('button', { name: 'More for Worker' })
  await user.click(more)
  return { user, more, view, popup: screen.getByRole('menu') }
}

it('associates delayed real FocusScope events with C1 and C2 even when both have detached', async () => {
  const tasks = holdPhysicalCloseTasks()
  const { user, more, popup: first } = await showMenu()
  const firstEvent = vi.fn()
  first.addEventListener('focusScope.autoFocusOnUnmount', firstEvent)
  await user.keyboard('{Escape}')
  expect(first.isConnected).toBe(false)
  await user.click(more)
  const second = screen.getByRole('menu')
  expect(second).not.toBe(first)
  const secondEvent = vi.fn()
  second.addEventListener('focusScope.autoFocusOnUnmount', secondEvent)
  await user.keyboard('{Escape}')
  expect(second.isConnected).toBe(false)
  expect(tasks).toHaveLength(2)
  const focus = vi.spyOn(more, 'focus')
  act(tasks[0])
  expect(firstEvent).toHaveBeenCalledOnce()
  expect(firstEvent.mock.calls[0][0].target).toBe(first)
  expect(focus).not.toHaveBeenCalled()
  act(tasks[1])
  expect(secondEvent).toHaveBeenCalledOnce()
  expect(secondEvent.mock.calls[0][0].target).toBe(second)
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  expect(more).toHaveFocus()
})

it.each([
  'display',
  'hidden',
  'inert',
  'aria-hidden',
  'disabled',
  'own-hidden',
  'removed'
] as const)('consumes a completed return with an %s invoker, without replay', async (death) => {
  const tasks = holdPhysicalCloseTasks()
  const { user, more, view } = await showMenu()
  const pane = screen.getByTestId('crew-pane')
  await user.keyboard('{Escape}')
  const focus = vi.spyOn(more, 'focus')
  if (death === 'display') {
    pane.style.display = 'none'
  } else if (death === 'disabled') {
    more.setAttribute('disabled', '')
  } else if (death === 'own-hidden') {
    more.hidden = true
  } else if (death === 'removed') {
    view.unmount()
  } else {
    pane.setAttribute(death, death === 'aria-hidden' ? 'true' : '')
  }
  act(tasks[0])
  expect(focus).not.toHaveBeenCalled()
  pane.removeAttribute('style')
  pane.removeAttribute(death)
  more.removeAttribute('disabled')
  more.hidden = false
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(focus).not.toHaveBeenCalled()
})

it.each(['stable', 'later', 'removed'] as const)(
  'uses the current %s destination rather than selected-action history',
  async (destination) => {
    const tasks = holdPhysicalCloseTasks()
    const { user, more } = await showMenu()
    const view = render(
      <div>
        <input key="first" aria-label="Action destination" />
        <input key="later" aria-label="Later destination" />
      </div>
    )
    const first = view.getByRole('textbox', { name: 'Action destination' })
    const later = view.getByRole('textbox', { name: 'Later destination' })
    rig.open.mockImplementationOnce(() => first.focus())
    await user.click(screen.getByRole('menuitem', { name: 'Open its chat' }))
    expect(rig.open).toHaveBeenCalledExactlyOnceWith(worker, host)
    if (destination === 'later') {
      later.focus()
    }
    if (destination === 'removed') {
      view.rerender(
        <div>
          <input key="later" aria-label="Later destination" />
        </div>
      )
    }
    act(tasks[0])
    expect(destination === 'stable' ? first : destination === 'later' ? later : more).toHaveFocus()
    expect(rig.copy).not.toHaveBeenCalled()
  }
)

it.each(['heading', 'inside-then-heading'] as const)(
  'lets Radix observe %s pointer dismissal without reclaiming focus',
  async (path) => {
    const { user, more, popup } = await showMenu()
    if (path === 'inside-then-heading') {
      await user.pointer({ target: popup, keys: '[MouseLeft]' })
      expect(screen.getByRole('menu')).toBe(popup)
    }
    const focus = vi.spyOn(more, 'focus')
    await user.click(screen.getByText('Orchestration'))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(focus).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    expect(rig.open).not.toHaveBeenCalled()
    expect(rig.copy).not.toHaveBeenCalled()
  }
)

it('returns while Open is pending and lets its original later destination own focus', async () => {
  const { user, more } = await showMenu()
  const view = render(<input aria-label="Delayed destination" />)
  let accept = () => {}
  rig.open.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        accept = () => {
          view.getByRole('textbox').focus()
          resolve()
        }
      })
  )
  await user.click(screen.getByRole('menuitem', { name: 'Open its chat' }))
  await waitFor(() => expect(more).toHaveFocus())
  expect(rig.open).toHaveBeenCalledExactlyOnceWith(worker, host)
  await act(async () => accept())
  expect(view.getByRole('textbox')).toHaveFocus()
  expect(rig.open).toHaveBeenCalledOnce()
})

it('resets outside provenance on a real same-node suspended exit reversal', async () => {
  const styles = document.createElement('style')
  styles.textContent =
    '[role="menu"][data-state="open"] { animation-name: crew-enter; } [role="menu"][data-state="closed"] { animation-name: crew-exit; }'
  document.head.append(styles)
  const { user, more, popup } = await showMenu()
  await user.click(screen.getByText('Orchestration'))
  expect(popup).toHaveAttribute('data-state', 'closed')
  expect(popup.isConnected).toBe(true)
  await user.click(more)
  expect(screen.getByRole('menu')).toBe(popup)
  expect(popup).toHaveAttribute('data-state', 'open')
  await user.keyboard('{Escape}')
  expect(popup).toHaveAttribute('data-state', 'closed')
  const end = new Event('animationend', { bubbles: true })
  Object.defineProperty(end, 'animationName', { value: 'crew-exit' })
  act(() => popup.dispatchEvent(end))
  await waitFor(() => expect(popup.isConnected).toBe(false))
  await waitFor(() => expect(more).toHaveFocus())
  styles.remove()
})

it('accounts for the existing Copy rejection at IO without changing action or focus policy', async () => {
  const { user, more } = await showMenu()
  const failure = new Error('fixture clipboard IPC rejected')
  const rejected: unknown[] = []
  const io = Promise.withResolvers<void>()
  const then = io.promise.then.bind(io.promise)
  function observeThen<T = void, R = never>(
    fulfilled?: ((value: void) => T | PromiseLike<T>) | null,
    failed?: ((reason: unknown) => R | PromiseLike<R>) | null
  ): Promise<T | R> {
    const child = then(fulfilled, failed)
    // The test IO boundary records the otherwise unhandled child rejection; production is unchanged.
    void child.catch((reason: unknown) => rejected.push(reason))
    return child
  }
  vi.spyOn(io.promise, 'then').mockImplementation(observeThen)
  rig.copy.mockReturnValueOnce(io.promise)
  await user.click(screen.getByRole('menuitem', { name: 'Copy address' }))
  await waitFor(() => expect(more).toHaveFocus())
  expect(rig.copy).toHaveBeenCalledExactlyOnceWith(worker.sendAddress)
  expect(rig.success).not.toHaveBeenCalled()
  await act(async () => {
    io.reject(failure)
    await Promise.resolve()
  })
  expect(rejected).toEqual([failure])
  expect(rig.success).not.toHaveBeenCalled()
  expect(more).toHaveFocus()
  expect(rig.open).not.toHaveBeenCalled()
})

it('keeps the live association through StrictMode replay and never steals a focused outside destination', async () => {
  const user = userEvent.setup()
  mount()
  cleanup()
  const view = render(
    <StrictMode>
      <TooltipProvider>
        <div className="pane">
          <OrchestrationCrewPanel
            target={host}
            party="term_strict"
            canMention={false}
            mention={rig.mention}
          />
        </div>
        <input aria-label="Outside" />
      </TooltipProvider>
    </StrictMode>
  )
  await user.click(screen.getByRole('button', { name: 'Show crew: 1 workers' }))
  const more = screen.getByRole('button', { name: 'More for Worker' })
  await user.click(more)
  const popup = screen.getByRole('menu')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(popup.isConnected).toBe(true)
  expect(more).not.toHaveFocus()
  fireEvent.keyDown(popup, { key: 'Escape', keyCode: 229 })
  expect(popup).toHaveAttribute('data-state', 'open')
  fireEvent.keyDown(popup, { key: 'Escape', isComposing: true })
  expect(popup).toHaveAttribute('data-state', 'open')
  const outside = view.getByRole('textbox')
  await user.click(outside)
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  expect(outside).toHaveFocus()
})

it.each(['empty', 'row-replaced', 'collapse'] as const)(
  'retires the actual menu owner on %s without a late return',
  async (retirement) => {
    const tasks = holdPhysicalCloseTasks()
    const { user, more, view } = await showMenu()
    const focus = vi.spyOn(more, 'focus')
    if (retirement === 'collapse') {
      await user.click(screen.getByRole('button', { name: 'Collapse crew panel' }))
    } else {
      rig.snapshot =
        retirement === 'empty'
          ? emptyCrew('ok')
          : {
              ...emptyCrew('ok'),
              sections: {
                managedBy: [],
                talkingWith: [],
                managing: [{ ...worker, partyKey: 'replacement', label: 'Replacement' }]
              }
            }
      view.rerender(
        <TooltipProvider>
          <div className="pane">
            <OrchestrationCrewPanel
              target={host}
              party="term_coordinator"
              canMention={false}
              mention={rig.mention}
            />
          </div>
        </TooltipProvider>
      )
    }
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(more.isConnected).toBe(false)
    expect(tasks).toHaveLength(1)
    act(tasks[0])
    expect(focus).not.toHaveBeenCalled()
    expect(rig.open).not.toHaveBeenCalled()
    expect(rig.copy).not.toHaveBeenCalled()
  }
)

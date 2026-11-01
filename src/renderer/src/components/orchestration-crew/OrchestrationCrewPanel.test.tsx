// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { OrchestrationCrewPanel } from './OrchestrationCrewPanel'

const rig = vi.hoisted(() => ({ snapshot: {}, open: vi.fn(), copy: vi.fn(), success: vi.fn() }))
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
function mount(row = worker, section: 'managing' | 'talkingWith' = 'managing') {
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
          <OrchestrationCrewPanel target={host} party="term_coordinator" />
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

it('keeps keyboard/body disclosure, chevron, Open, Copy, Escape and collapse independent', async () => {
  const user = userEvent.setup()
  mount()
  const tab = screen.getByRole('button', { name: 'Show crew: 1 workers' })
  tab.focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Collapse crew panel' })).toHaveFocus()
  expect(screen.getByText('Orchestration')).toBeInTheDocument()
  const body = screen.getByRole('button', { name: /Worker Check the result/ })
  expect(body).toHaveAttribute('aria-expanded', 'false')
  body.focus()
  await user.keyboard(' ')
  expect(body).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('The result is ready.')).toBeInTheDocument()
  expect(rig.open).not.toHaveBeenCalled()
  expect(rig.copy).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: "Show Worker's task and latest message" }))
  expect(body).toHaveAttribute('aria-expanded', 'false')
  await user.click(body)
  expect(body).toHaveAttribute('aria-expanded', 'true')
  const open = screen.getByRole('button', { name: 'Open Worker' })
  open.focus()
  await user.keyboard('{Enter}')
  expect(rig.open).toHaveBeenCalledExactlyOnceWith(worker, host)
  expect(body).toHaveAttribute('aria-expanded', 'true')
  await user.click(screen.getByRole('button', { name: 'More for Worker' }))
  await user.click(screen.getByRole('menuitem', { name: 'Copy address' }))
  expect(rig.copy).toHaveBeenCalledExactlyOnceWith('dispatch:d1')
  expect(rig.success).toHaveBeenCalledExactlyOnceWith("Copied Worker's address")
  expect(rig.open).toHaveBeenCalledOnce()
  expect(body).toHaveAttribute('aria-expanded', 'true')
  await user.click(screen.getByRole('button', { name: 'More for Worker' }))
  const menuOpen = screen.getByRole('menuitem', { name: 'Open its chat' })
  menuOpen.focus()
  await user.keyboard('{Enter}')
  expect(rig.open).toHaveBeenCalledTimes(2)
  expect(rig.open).toHaveBeenLastCalledWith(worker, host)
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  expect(body).toHaveAttribute('aria-expanded', 'true')
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
      <OrchestrationCrewPanel target={host} party="term_worker" />
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
        <OrchestrationCrewPanel target={host} party="term_coordinator" />
      </TooltipProvider>
    )
    const tab = screen.getByRole('button', { name: 'Show crew: 2 workers' })
    expect(within(tab).getAllByLabelText('Needs attention')).toHaveLength(1)
    expect(within(tab).getAllByLabelText('Working')).toHaveLength(1)
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
  mount(peer, 'talkingWith')
  await user.click(screen.getByRole('button', { name: 'Show crew: Talking with Worker' }))
  expect(screen.getAllByText('Sending unavailable')).toHaveLength(1)
  const body = screen.getByRole('button', { name: /Worker Check the result/ })
  await user.click(body)
  expect(body).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('The result is ready.')).toBeInTheDocument()
  expect(screen.getAllByText('Sending unavailable')).toHaveLength(1)
  await user.hover(screen.getByRole('img', { name: 'Codex · Remote host' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Codex · Remote host')
  expect(screen.queryByText('codex')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Open Worker' }))
  expect(rig.open).toHaveBeenCalledExactlyOnceWith(peer, host)
  await user.click(screen.getByRole('button', { name: 'More for Worker' }))
  const copy = screen.getByRole('menuitem', { name: 'Copy address' })
  expect(copy).toHaveAttribute('aria-disabled', 'true')
  await user.click(copy)
  expect(rig.copy).not.toHaveBeenCalled()
  expect(screen.getAllByText('Sending unavailable')).toHaveLength(1)
})

// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VmBuildFailureCard, type VmBuildFailureActions } from './VmBuildFailureCard'
import type { VmBuildFailure } from './vm-build-failure'
import { vmBuildFailureCopy } from './vm-build-failure-copy'
import { InlineError } from '@/components/ui/inline-error'
import { translate } from '@/i18n/i18n'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const actions = (): VmBuildFailureActions => ({
  onFixWithAgent: vi.fn(),
  onRetry: vi.fn(),
  onEditRecipe: vi.fn(),
  onOpenAnyway: vi.fn(),
  onStartAgain: vi.fn(),
  onDismiss: vi.fn(),
  onSeePlans: vi.fn(),
  onOpenBilling: vi.fn(),
  onCreateLocally: vi.fn(),
  onSignIn: vi.fn(),
  onShowWorkspaces: vi.fn(),
  onContactSupport: vi.fn(),
  onConnectGitHub: vi.fn(),
  onPushToGitHub: vi.fn()
})

function Sheet({
  failure,
  connectingGitHub = false,
  canManageBilling = true,
  handlers
}: {
  failure: VmBuildFailure | null
  connectingGitHub?: boolean
  canManageBilling?: boolean
  handlers: VmBuildFailureActions
}) {
  return (
    <div data-vm-build-sheet>
      <h2 data-vm-build-heading tabIndex={-1}>
        Starting your cloud workspace
      </h2>
      <VmBuildFailureCard
        failure={failure}
        cloud
        vmKept={false}
        firstErrorLine={null}
        canFixWithAgent={false}
        canManageBilling={canManageBilling}
        signingIn={false}
        connectingGitHub={connectingGitHub}
        repoName="acme/web"
        actions={handlers}
      />
    </div>
  )
}

it('announces only the cause and lands focus on it, then on the sheet heading after Try again', () => {
  const handlers = actions()
  const { rerender } = render(<Sheet failure={{ kind: 'unavailable' }} handlers={handlers} />)
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain('Orca Cloud is unavailable right now')
  // The buttons are read on demand, not announced with the cause.
  expect(alert.querySelector('button')).toBeNull()
  expect(document.activeElement?.textContent).toBe('Orca Cloud is unavailable right now')

  const retry = screen.getByRole('button', { name: /Try again/ })
  retry.focus()
  fireEvent.click(retry)
  expect(handlers.onRetry).toHaveBeenCalledOnce()
  act(() => rerender(<Sheet failure={null} handlers={handlers} />))
  expect(document.activeElement?.hasAttribute('data-vm-build-heading')).toBe(true)
})

it('keeps a pending Connect GitHub focusable and ignores repeat clicks', () => {
  const handlers = actions()
  render(<Sheet failure={{ kind: 'githubNotConnected' }} connectingGitHub handlers={handlers} />)
  const button = screen.getByRole('button', { name: /Opening GitHub/ })
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(button.getAttribute('aria-busy')).toBe('true')
  button.focus()
  fireEvent.click(button)
  expect(handlers.onConnectGitHub).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(button)
})

it('offers an owner See plans then Try again on no plan', () => {
  const handlers = actions()
  render(<Sheet failure={{ kind: 'plan' }} handlers={handlers} />)
  const buttons = screen.getAllByRole('button').map((button) => button.textContent?.trim())
  expect(buttons.slice(0, 2)).toEqual(['See plans', 'Try again'])
  fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
  expect(handlers.onRetry).toHaveBeenCalledOnce()
})

it.each(['plan', 'hoursUsed', 'spendCap', 'payment'] as const)(
  'gives a member running into %s a way to create on this computer, not a billing fix',
  (kind) => {
    const handlers = actions()
    render(<Sheet failure={{ kind }} canManageBilling={false} handlers={handlers} />)
    expect(
      screen.queryByRole('button', { name: /See plans|Raise spend cap|Turn on overage/ })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Use this computer instead/ }))
    expect(handlers.onCreateLocally).toHaveBeenCalledOnce()
  }
)

it("keeps Use this computer instead beside an owner's billing fix", () => {
  const handlers = actions()
  render(<Sheet failure={{ kind: 'spendCap' }} handlers={handlers} />)
  const buttons = screen.getAllByRole('button').map((button) => button.textContent?.trim())
  expect(buttons.slice(0, 2)).toEqual(['Raise spend cap', 'Use this computer instead'])
})

// The card counts down from the real clock; pin it so the minutes read the same every run.
const FIXED_NOW = 1_700_000_000_000

const FATAL: VmBuildFailure = {
  kind: 'checks',
  problems: [
    {
      id: 'environment.doctor',
      category: 'workspace',
      status: 'fail',
      message: 'The environment checks could not finish: unreachable'
    }
  ],
  sleepsAt: FIXED_NOW + 5 * 60_000
}

function cloudCard(failure: VmBuildFailure, handlers: VmBuildFailureActions, vmKept = true) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  return (
    <div data-vm-build-sheet>
      <VmBuildFailureCard
        failure={failure}
        cloud
        vmKept={vmKept}
        firstErrorLine={null}
        canFixWithAgent={false}
        canManageBilling
        signingIn={false}
        connectingGitHub={false}
        repoName="acme/web"
        actions={handlers}
      />
    </div>
  )
}

it('Orca Cloud: an unusable sandbox leads with Start again and says when it sleeps', () => {
  const handlers = actions()
  render(cloudCard(FATAL, handlers))
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain('This sandbox can’t open your workspace')
  expect(screen.getByText('Orca couldn’t reach the sandbox.')).toBeTruthy()
  // Never "until you choose": the sandbox stops spending hours on its own.
  expect(screen.getByText('Sleeps in 5 minutes if unused.')).toBeTruthy()
  const buttons = screen.getAllByRole('button').map((button) => button.textContent?.trim())
  expect(buttons).toEqual(['Start again', 'Run checks again', 'Delete sandbox'])
  fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
  expect(handlers.onStartAgain).toHaveBeenCalledOnce()
})

it('Orca Cloud: once asleep, checking again is gone and the card says it uses no hours', () => {
  render(cloudCard({ ...FATAL, sandbox: 'asleep' }, actions()))
  expect(screen.getByText('Asleep. It isn’t using sandbox hours.')).toBeTruthy()
  const buttons = screen.getAllByRole('button').map((button) => button.textContent?.trim())
  expect(buttons).toEqual(['Start again', 'Delete sandbox'])
})

it('Orca Cloud: a sandbox deleted instead of slept leaves nothing to delete', () => {
  render(cloudCard({ ...FATAL, sandbox: 'deleted' }, actions(), false))
  expect(screen.getByRole('alert').textContent).toContain('The sandbox was deleted.')
  const buttons = screen.getAllByRole('button').map((button) => button.textContent?.trim())
  expect(buttons).toEqual(['Start again', 'Dismiss'])
})

it('reads an account limit as a neutral notice rather than an error', () => {
  render(<Sheet failure={{ kind: 'plan' }} handlers={actions()} />)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Orca Cloud needs a Team plan')
})

it('says nothing was created only when no sandbox is left running', () => {
  const failure: VmBuildFailure = { kind: 'provision', error: 'boom' }
  const context = { cloud: true, canManageBilling: true, repoName: 'acme/web' }
  expect(vmBuildFailureCopy(failure, context, translate).body).toContain(
    'Nothing was created, and you weren’t charged.'
  )
  const kept = vmBuildFailureCopy(failure, { ...context, sandboxKept: true }, translate).body
  expect(kept).not.toContain('Nothing was created')
  expect(kept).toContain('delete the sandbox')
})

it('recipe VMs keep counting failed checks in the title', () => {
  const context = { cloud: false, canManageBilling: true, repoName: 'acme/web' }
  const problems: VmBuildFailure = {
    kind: 'checks',
    problems: [
      { id: 'tool.pnpm', category: 'tools', status: 'fail', message: 'pnpm is missing.' },
      { id: 'disk.free', category: 'disk', status: 'warn', message: 'Low disk.' }
    ]
  }
  expect(vmBuildFailureCopy(problems, context, translate).title).toBe(
    'The VM is up, but 1 environment check failed'
  )
})

it('keeps InlineError announcing the whole box without children, and only the text with them', () => {
  const { rerender } = render(<InlineError title="Couldn't load keys." detail="Try later." />)
  expect(screen.getByRole('alert').getAttribute('data-slot')).toBe('inline-error')
  rerender(
    <InlineError title="Couldn't load keys." detail="Try later.">
      {false}
    </InlineError>
  )
  expect(screen.getByRole('alert').getAttribute('data-slot')).toBe('inline-error')
  rerender(
    <InlineError title="Couldn't load keys." detail="Try later.">
      <button type="button">Fix</button>
    </InlineError>
  )
  const alert = screen.getByRole('alert')
  expect(alert.getAttribute('data-slot')).toBeNull()
  expect(alert.textContent).toBe("Couldn't load keys.Try later.")
})

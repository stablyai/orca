// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VmBuildFailureCard, type VmBuildFailureActions } from './VmBuildFailureCard'
import type { VmBuildFailure } from './vm-build-failure'
import { vmBuildFailureCopy } from './vm-build-failure-copy'
import { InlineError } from '@/components/ui/inline-error'
import { translate } from '@/i18n/i18n'

afterEach(cleanup)

const actions = (): VmBuildFailureActions => ({
  onFixWithAgent: vi.fn(),
  onRetry: vi.fn(),
  onEditRecipe: vi.fn(),
  onOpenAnyway: vi.fn(),
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

const CHECKS: VmBuildFailure = {
  kind: 'checks',
  problems: [
    { id: 'tool.pnpm', category: 'tools', status: 'fail', message: 'pnpm is missing.' },
    { id: 'agent.claude', category: 'agents', status: 'warn', message: 'Claude is signed out.' },
    { id: 'git.push', category: 'git', status: 'fail', message: 'Push was refused.' }
  ]
}

it('counts only failed checks in the title and leads with Open anyway on a running sandbox', () => {
  const handlers = actions()
  render(
    <div data-vm-build-sheet>
      <VmBuildFailureCard
        failure={CHECKS}
        cloud
        vmKept
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
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain('The sandbox is up, but 2 environment checks failed')
  // The check rows are read on demand, not announced with the cause.
  expect(alert.textContent).not.toContain('pnpm is missing')
  const buttons = screen.getAllByRole('button').map((button) => button.textContent?.trim())
  expect(buttons).toEqual(['Open anyway', 'Run checks again', 'Delete sandbox'])
  fireEvent.click(screen.getByRole('button', { name: 'Open anyway' }))
  expect(handlers.onOpenAnyway).toHaveBeenCalledOnce()
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

it('uses the singular for one failed check and names warnings-only runs as needing attention', () => {
  const context = { cloud: true, canManageBilling: true, repoName: 'acme/web' }
  const one: VmBuildFailure = { kind: 'checks', problems: CHECKS.problems.slice(0, 2) }
  const copy = vmBuildFailureCopy(one, context, translate)
  expect(copy.title).toBe('The sandbox is up, but 1 environment check failed')
  expect(copy.body).toContain('fix them')
  const warningOnly: VmBuildFailure = { kind: 'checks', problems: CHECKS.problems.slice(1, 2) }
  const warned = vmBuildFailureCopy(warningOnly, context, translate)
  expect(warned.title).toBe('The sandbox is up, but some environment checks need attention')
  expect(warned.body).toContain('fix it inside')
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

// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VmBuildFailureCard, type VmBuildFailureActions } from './VmBuildFailureCard'
import type { VmBuildFailure } from './vm-build-failure'

afterEach(cleanup)

const actions = (): VmBuildFailureActions => ({
  onFixWithAgent: vi.fn(),
  onRetry: vi.fn(),
  onEditRecipe: vi.fn(),
  onOpenAnyway: vi.fn(),
  onDismiss: vi.fn(),
  onSeePlans: vi.fn(),
  onOpenBilling: vi.fn(),
  onSignIn: vi.fn(),
  onShowWorkspaces: vi.fn(),
  onContactSupport: vi.fn(),
  onConnectGitHub: vi.fn(),
  onPushToGitHub: vi.fn()
})

function Sheet({
  failure,
  connectingGitHub = false,
  handlers
}: {
  failure: VmBuildFailure | null
  connectingGitHub?: boolean
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
        canManageBilling
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

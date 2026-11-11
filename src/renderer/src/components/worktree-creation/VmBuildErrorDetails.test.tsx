// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VmBuildFailureCard, type VmBuildFailureActions } from './VmBuildFailureCard'
import { localRawError, type VmBuildFailure } from './vm-build-failure'

afterEach(cleanup)

const writeClipboardText = vi.fn()
beforeEach(() => {
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: { ...window.api, ui: { ...window.api?.ui, writeClipboardText } } })
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

function Card({
  failure,
  cloud = false,
  firstErrorLine = null
}: {
  failure: VmBuildFailure
  cloud?: boolean
  firstErrorLine?: string | null
}) {
  return (
    <div data-vm-build-sheet>
      <VmBuildFailureCard
        failure={failure}
        cloud={cloud}
        vmKept={false}
        firstErrorLine={firstErrorLine}
        canFixWithAgent={false}
        canManageBilling
        signingIn={false}
        connectingGitHub={false}
        repoName="acme/web"
        actions={actions()}
      />
    </div>
  )
}

it('shows a plain summary and keeps the raw recipe error collapsed behind Details', () => {
  render(
    <Card
      failure={{ kind: 'provision', error: 'Recipe exited with code 1.' }}
      firstErrorLine="Error: snapshot snap_7f2c not found"
    />
  )
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain('Your VM recipe stopped with an error')
  expect(alert.textContent).not.toContain('Recipe exited')
  const toggle = screen.getByRole('button', { name: 'Details' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByTestId('vm-build-error-details-text')).toBeNull()

  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const text = screen.getByTestId('vm-build-error-details-text').textContent
  expect(text).toBe('Recipe exited with code 1.\n\nError: snapshot snap_7f2c not found')
  expect(screen.queryByText(/earlier line/)).toBeNull()
})

it('notes a single hidden earlier line in the singular', () => {
  const error = Array.from({ length: 21 }, (_, index) => `line ${index + 1}`).join('\n')
  render(<Card failure={{ kind: 'create', error }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(screen.getByText('…1 earlier line. Copy details includes it.')).toBeTruthy()
})

it('shows the last 20 lines of a long error but copies all of them, then confirms', async () => {
  const error = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
  render(<Card failure={{ kind: 'create', error }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  const text = screen.getByTestId('vm-build-error-details-text').textContent ?? ''
  expect(text.split('\n')).toEqual(Array.from({ length: 20 }, (_, index) => `line ${index + 11}`))
  expect(screen.getByText('…10 earlier lines. Copy details includes them.')).toBeTruthy()

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }))
  })
  expect(writeClipboardText).toHaveBeenCalledWith(error)
  expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  expect(screen.getByText('Details copied')).toBeTruthy()
})

it('never shows raw errors on Orca Cloud cards', () => {
  render(<Card cloud failure={{ kind: 'provision', error: 'sandbox sbx_41d9 exploded' }} />)
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  expect(document.body.textContent).not.toContain('sbx_41d9')
})

it('builds the raw text only for local recipe and create failures', () => {
  expect(localRawError({ kind: 'network' }, 'x')).toBeNull()
  expect(localRawError({ kind: 'create', error: 'boom' }, 'Error: other')).toBe('boom')
  expect(localRawError({ kind: 'provision', error: 'Error: x' }, 'Error: x')).toBe('Error: x')
  expect(localRawError({ kind: 'provision', error: '  ' }, null)).toBeNull()
})

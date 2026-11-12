// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EmptyState, ErrorState } from './CloudWorkspacesStates'
import {
  INITIAL_CLOUD_WORKSPACE_FILTERS as DEFAULTS,
  shouldShowCloudHomeFilters
} from './CloudWorkspacesToolbar'

afterEach(cleanup)

it('shows an expired session as a neutral status with Sign in, not an alert with Try again', () => {
  const onSignIn = vi.fn()
  const onRetry = vi.fn()
  render(<ErrorState error="unauthorized" retrying={false} onRetry={onRetry} onSignIn={onSignIn} />)
  expect(screen.getByRole('status').textContent).toContain('Sign in to Orca again to continue.')
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(onSignIn).toHaveBeenCalledTimes(1)
  expect(onRetry).not.toHaveBeenCalled()
})

it('keeps other failures as an alert with Try again', () => {
  const onRetry = vi.fn()
  render(<ErrorState error="unavailable" retrying={false} onRetry={onRetry} onSignIn={vi.fn()} />)
  expect(screen.getByRole('alert')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})

it('at the running-sandbox limit offers Show cloud workspaces instead of a retry', () => {
  const onRetry = vi.fn()
  render(
    <ErrorState
      error="entitlement_denied"
      reason="concurrency_limit"
      retrying={false}
      onRetry={onRetry}
      onSignIn={vi.fn()}
    />
  )
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Show cloud workspaces' })).toBeTruthy()
})

it('an empty list invites the first cloud workspace, with one button (JA-30)', () => {
  render(<EmptyState scope="team" archived={false} filtered={false} />)
  expect(screen.getByText('Start your first cloud workspace')).toBeTruthy()
  expect(
    screen.getByText(
      'It runs in a sandbox, so your agents keep working even when this computer is off.'
    )
  ).toBeTruthy()
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['New cloud workspace'])
})

it('an empty Mine list on a team says yours is empty, with the same button', () => {
  render(<EmptyState scope="mine" archived={false} filtered={false} hasOrg />)
  expect(screen.getByText('You don’t have any cloud workspaces yet.')).toBeTruthy()
  expect(screen.queryByText('Start your first cloud workspace')).toBeNull()
  expect(screen.getByRole('button', { name: 'New cloud workspace' })).toBeTruthy()
  cleanup()
  // No team: Mine is the only list, so it is the first-run invitation.
  render(<EmptyState scope="mine" archived={false} filtered={false} hasOrg={false} />)
  expect(screen.getByText('Start your first cloud workspace')).toBeTruthy()
})

it('filtered and archived empty lists keep their own copy and offer no create button', () => {
  render(<EmptyState scope="team" archived={false} filtered />)
  expect(screen.getByText('Nothing matches these filters')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it('shows the filters from 5 workspaces, or whenever a filter is on so it can be undone', () => {
  expect(shouldShowCloudHomeFilters(0, DEFAULTS, true)).toBe(false)
  expect(shouldShowCloudHomeFilters(4, DEFAULTS, true)).toBe(false)
  expect(shouldShowCloudHomeFilters(5, DEFAULTS, true)).toBe(true)
  // The Archived switch alone doesn't bring the full row (ARCHIVE-REACH): the list's size does.
  expect(shouldShowCloudHomeFilters(2, { ...DEFAULTS, archived: true }, true)).toBe(false)
  expect(shouldShowCloudHomeFilters(5, { ...DEFAULTS, archived: true }, true)).toBe(true)
  expect(shouldShowCloudHomeFilters(1, { ...DEFAULTS, scope: 'mine' }, true)).toBe(true)
  expect(shouldShowCloudHomeFilters(1, { ...DEFAULTS, repo: 'https://x/y' }, true)).toBe(true)
  expect(shouldShowCloudHomeFilters(1, { ...DEFAULTS, running: true }, true)).toBe(true)
  // Without a team there is no Team/Mine choice: Mine is not a filter there.
  expect(shouldShowCloudHomeFilters(1, { ...DEFAULTS, scope: 'mine' }, false)).toBe(false)
})

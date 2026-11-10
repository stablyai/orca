// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ErrorState } from './CloudWorkspacesStates'

afterEach(cleanup)

it('shows an expired session as a neutral status with Sign in, not an alert with Retry', () => {
  const onSignIn = vi.fn()
  const onRetry = vi.fn()
  render(<ErrorState error="unauthorized" retrying={false} onRetry={onRetry} onSignIn={onSignIn} />)
  expect(screen.getByRole('status').textContent).toContain('Sign in to Orca again to continue.')
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(onSignIn).toHaveBeenCalledTimes(1)
  expect(onRetry).not.toHaveBeenCalled()
})

it('keeps other failures as an alert with Retry', () => {
  const onRetry = vi.fn()
  render(<ErrorState error="unavailable" retrying={false} onRetry={onRetry} onSignIn={vi.fn()} />)
  expect(screen.getByRole('alert')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})

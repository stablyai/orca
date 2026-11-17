// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ErrorState, PickerEmptyState } from './CloudWorkspacesStates'
import {
  closeCloudWorkspacePicker,
  getCloudWorkspacePickerRequest
} from './cloud-workspace-picker-store'

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

it('at the running limit, Show cloud workspaces opens the picker on your running ones', () => {
  render(
    <ErrorState
      error="entitlement_denied"
      reason="member_concurrency_limit"
      retrying={false}
      onRetry={vi.fn()}
      onSignIn={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Show cloud workspaces' }))
  expect(getCloudWorkspacePickerRequest()?.focus).toEqual({ kind: 'running' })
  closeCloudWorkspacePicker()
})

it('with none at all, says so and offers New cloud workspace as the primary action', () => {
  const onCreate = vi.fn()
  render(<PickerEmptyState reason={{ kind: 'none' }} onCreate={onCreate} />)
  expect(screen.getByText('No cloud workspaces yet')).toBeTruthy()
  expect(screen.getByText('Start one and it shows up in your sidebar.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'New cloud workspace' }))
  expect(onCreate).toHaveBeenCalledTimes(1)
})

it('with everything in the sidebar, says there is nothing else and keeps a secondary New', () => {
  render(<PickerEmptyState reason={{ kind: 'all-in-sidebar' }} onCreate={vi.fn()} />)
  expect(screen.getByText('Nothing else to open')).toBeTruthy()
  expect(
    screen.getByText('Every cloud workspace you can open is already in your sidebar.')
  ).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'New cloud workspace' }).getAttribute('data-variant')
  ).toBe('outline')
})

it('a search with no match keeps its own copy and offers no create button', () => {
  render(<PickerEmptyState reason={{ kind: 'search' }} onCreate={vi.fn()} />)
  expect(screen.getByText('Nothing matches your search')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

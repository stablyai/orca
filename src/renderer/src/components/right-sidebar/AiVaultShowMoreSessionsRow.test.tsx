// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AiVaultShowMoreSessionsRow } from './AiVaultShowMoreSessionsRow'

afterEach(cleanup)

it('steps the history depth up by one page while more sessions may exist', async () => {
  const onSessionLimitChange = vi.fn()
  render(
    <AiVaultShowMoreSessionsRow
      mayHoldMoreSessions
      loading={false}
      sessionLimit={500}
      onSessionLimitChange={onSessionLimitChange}
    />
  )
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show more sessions' }))
  expect(onSessionLimitChange).toHaveBeenCalledWith(750)
})

it('stays put in a loading state while the deeper rescan runs', () => {
  render(
    <AiVaultShowMoreSessionsRow
      mayHoldMoreSessions
      loading
      sessionLimit={500}
      onSessionLimitChange={vi.fn()}
    />
  )
  const button = screen.getByRole('button', { name: 'Loading more sessions…' })
  expect(button.hasAttribute('disabled')).toBe(true)
})

it('stays hidden when nothing deeper is left to read', () => {
  render(
    <AiVaultShowMoreSessionsRow
      mayHoldMoreSessions={false}
      loading={false}
      sessionLimit={250}
      onSessionLimitChange={vi.fn()}
    />
  )
  expect(screen.queryByRole('button')).toBeNull()
})

it('stays hidden once the user asked for unlimited depth', () => {
  render(
    <AiVaultShowMoreSessionsRow
      mayHoldMoreSessions
      loading={false}
      sessionLimit="unlimited"
      onSessionLimitChange={vi.fn()}
    />
  )
  expect(screen.queryByRole('button')).toBeNull()
})

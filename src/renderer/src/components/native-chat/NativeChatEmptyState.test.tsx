// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatEmptyState } from './NativeChatEmptyState'

afterEach(cleanup)

it('keeps pointing the terminal-backed chat back to its terminal when a read fails', () => {
  render(<NativeChatEmptyState kind="error" />)
  expect(
    screen.getByText(
      'The transcript could not be read. Toggle back to the terminal to keep working.'
    )
  ).toBeInTheDocument()
})

// It retries on its own, which the pane does not report, and has no terminal to point back to.
it('says only that the structured chat did not load while its read retries', () => {
  const { container } = render(<NativeChatEmptyState kind="error" retrying />)
  expect(screen.getByText('Could not load conversation')).toBeInTheDocument()
  expect(container.querySelectorAll('p')).toHaveLength(1)
})

it('shows the host message in place of the terminal-backed default', () => {
  render(<NativeChatEmptyState kind="error" message="disk full" />)
  expect(screen.getByText('disk full')).toBeInTheDocument()
  expect(screen.queryByText(/Toggle back to the terminal/)).toBeNull()
})

// The structured chat passes words only from the notice table, never the host's.
it("says the structured chat's own words for the failure once, as the title, and nothing more", () => {
  const { container } = render(
    <NativeChatEmptyState
      kind="error"
      retrying
      headline="Orca couldn't open this chat's history right now."
    />
  )
  expect(screen.getByText("Orca couldn't open this chat's history right now.")).toHaveClass(
    'font-medium'
  )
  expect(screen.queryByText('Could not load conversation')).toBeNull()
  expect(container.querySelectorAll('p')).toHaveLength(1)
})

it('says a failure no retry gets past in its one line, with nothing of trying again', () => {
  render(<NativeChatEmptyState kind="error" headline="Unable to load this chat." />)
  expect(screen.getByText('Unable to load this chat.')).toHaveClass('font-medium')
  expect(screen.queryByText('Could not load conversation')).toBeNull()
  expect(screen.queryByText(/keeps trying|Toggle back/)).toBeNull()
})

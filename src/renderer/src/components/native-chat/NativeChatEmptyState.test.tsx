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

it('tells the structured chat its read keeps retrying', () => {
  render(<NativeChatEmptyState kind="error" retrying />)
  expect(
    screen.getByText('The transcript could not be read. Orca keeps trying to load it.')
  ).toBeInTheDocument()
})

it('shows the host message over either default', () => {
  render(<NativeChatEmptyState kind="error" retrying message="disk full" />)
  expect(screen.getByText('disk full')).toBeInTheDocument()
})

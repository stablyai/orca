// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AiVaultGroupMoreRow } from './AiVaultGroupMoreRow'

afterEach(cleanup)

it('offers the hidden count and toggles the group open', async () => {
  const onToggle = vi.fn()
  render(<AiVaultGroupMoreRow hiddenCount={256} expanded={false} onToggle={onToggle} />)

  const button = screen.getByRole('button', { name: 'Show 256 more' })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  await userEvent.setup().click(button)
  expect(onToggle).toHaveBeenCalledTimes(1)
})

it('offers Show fewer once the group is expanded', () => {
  render(<AiVaultGroupMoreRow hiddenCount={256} expanded onToggle={vi.fn()} />)

  const button = screen.getByRole('button', { name: 'Show fewer' })
  expect(button.getAttribute('aria-expanded')).toBe('true')
})

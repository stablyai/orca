// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { aiVaultBrowseSortMenu, aiVaultSearchSortMenu } from './ai-vault-sort-options'
import {
  aiVaultResultCountLabel,
  AiVaultSessionListBar,
  aiVaultSessionCountLabel
} from './AiVaultSessionListBar'

afterEach(cleanup)

it('reports how many hits are shown and which order produced them', () => {
  const { rerender } = render(
    <AiVaultSessionListBar
      label={aiVaultResultCountLabel(1)}
      value="relevance"
      menu={aiVaultSearchSortMenu()}
      onChange={vi.fn()}
    />
  )
  expect(screen.getByText('1 result')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sort results: Most relevant' })).toBeTruthy()

  rerender(
    <AiVaultSessionListBar
      label={aiVaultResultCountLabel(20)}
      value="newest"
      menu={aiVaultSearchSortMenu()}
      onChange={vi.fn()}
    />
  )
  expect(screen.getByText('20 results')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sort results: Newest' })).toBeTruthy()
})

it('reports how much of the browsed history is shown and its order', () => {
  render(
    <AiVaultSessionListBar
      label={aiVaultSessionCountLabel(4, 12)}
      value="created"
      menu={aiVaultBrowseSortMenu()}
      onChange={vi.fn()}
    />
  )
  expect(screen.getByText('4 of 12 sessions')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sort sessions: Created' })).toBeTruthy()
})

it('counts plainly when filters hide nothing', () => {
  render(
    <AiVaultSessionListBar
      label={aiVaultSessionCountLabel(12, 12)}
      value="updated"
      menu={aiVaultBrowseSortMenu()}
      onChange={vi.fn()}
    />
  )
  expect(screen.getByText('12 sessions')).toBeTruthy()
})

it('hands the picked search order back to the caller', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  render(
    <AiVaultSessionListBar
      label={aiVaultResultCountLabel(20)}
      value="relevance"
      menu={aiVaultSearchSortMenu()}
      onChange={onChange}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Sort results: Most relevant' }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'Newest' }))

  expect(onChange).toHaveBeenCalledExactlyOnceWith('newest')
})

it('hands the picked browse order back to the caller', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  render(
    <AiVaultSessionListBar
      label={aiVaultSessionCountLabel(4, 12)}
      value="updated"
      menu={aiVaultBrowseSortMenu()}
      onChange={onChange}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Sort sessions: Last updated' }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'Created' }))

  expect(onChange).toHaveBeenCalledExactlyOnceWith('created')
})

it('marks a total that is only the scan cap', () => {
  expect(aiVaultSessionCountLabel(500, 500, true)).toBe('500+ sessions')
  expect(aiVaultSessionCountLabel(12, 500, true)).toBe('12 of 500+ sessions')
  expect(aiVaultSessionCountLabel(500, 500)).toBe('500 sessions')
})

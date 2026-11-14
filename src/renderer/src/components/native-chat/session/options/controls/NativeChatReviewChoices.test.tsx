// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'

afterEach(cleanup)

it.each([1000, 10000])('windows %i branches while searching the complete list', (count) => {
  const choices = Array.from({ length: count }, (_, i) => ({
    value: `topic-${i}`,
    label: `Topic ${i}`
  }))
  const select = vi.fn()
  render(
    <NativeChatModelCombobox
      choices={choices}
      currentValue={undefined}
      readOnly={false}
      readOnlyReason={null}
      busy={false}
      onSelect={select}
      review={{ label: 'Search branches…' }}
    />
  )
  // 233px viewport, one 32px minimum row and four overscan rows on either side.
  expect(screen.getAllByRole('option').length).toBeLessThanOrEqual(16)
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: 'topic-999' } })
  expect(screen.getByText('Topic 999')).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(select).toHaveBeenCalledWith('topic-999')
})

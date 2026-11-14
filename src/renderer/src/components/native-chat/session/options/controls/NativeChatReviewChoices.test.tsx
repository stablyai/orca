// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'

beforeEach(() => {
  // happy-dom has no layout; keep the real virtualizer with browser-sized list geometry.
  for (const key of ['offsetHeight', 'clientHeight'] as const) {
    vi.spyOn(HTMLElement.prototype, key, 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('cmdk-list') ? 233 : 32
    })
  }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(384)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return new DOMRect(0, 0, 384, this.hasAttribute('cmdk-list') ? 233 : 32)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([1000, 10000])('windows %i branches while searching the complete list', async (count) => {
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
  expect(await screen.findByText('Topic 999')).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(select).toHaveBeenCalledWith('topic-999')
})

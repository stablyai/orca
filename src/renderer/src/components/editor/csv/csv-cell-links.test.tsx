// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CsvCellValue } from './CsvCellValue'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('opens a whole-cell URL without navigating the renderer or changing its displayed text', () => {
  const onOpenUrl = vi.fn()
  render(<CsvCellValue value=" https://example.com/a?q=b#section " onOpenUrl={onOpenUrl} />)
  const link = screen.getByRole('link')
  expect(link.textContent).toBe(' https://example.com/a?q=b#section ')
  expect(link.getAttribute('href')).toBe('https://example.com/a?q=b#section')
  expect(fireEvent.click(link)).toBe(false)
  expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/a?q=b#section', expect.anything())
  fireEvent(link, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
  expect(onOpenUrl).toHaveBeenCalledTimes(2)
})

it.each([
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///tmp/example.csv',
  'https://',
  'https://[broken',
  'See https://example.com for details',
  '<a href="https://example.com">click</a>'
])('keeps non-URLs and executable content as literal text: %s', (value) => {
  render(<CsvCellValue value={value} onOpenUrl={vi.fn()} />)
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getByText(value)).toBeTruthy()
})

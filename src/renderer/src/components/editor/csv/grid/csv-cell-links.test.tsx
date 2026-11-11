// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CsvCellValue } from './CsvCellValue'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

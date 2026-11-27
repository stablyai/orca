import { expect, it } from 'vitest'
import { sheetTable } from './sheets-a1'

// Node pool: V8's argument limit (Electron, CLI) is far below Bun's.
it('renders a tab with more rows than the argument limit', () => {
  const table = sheetTable(
    Array.from({ length: 150_000 }, () => ['value']),
    { row: 1, column: 1 }
  )
  expect(table.endsWith('\n150000 | value')).toBe(true)
})

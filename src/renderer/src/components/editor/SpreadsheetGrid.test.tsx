// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { SpreadsheetGrid } from './SpreadsheetGrid'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(element: React.JSX.Element): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root!.render(element)
  })
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

const WIDE_COLUMN_COUNT = 5000

describe('SpreadsheetGrid', () => {
  it('renders far fewer cells than a wide sheet declares columns', () => {
    // Why: a sheet whose last used cell sits far to the right reports thousands of
    // columns. Rendering one cell per column in every visible row put hundreds of
    // thousands of nodes in the document and a template string that long in the
    // inline style of each row.
    const header = Array.from({ length: WIDE_COLUMN_COUNT }, (_, index) => `C${index}`)
    const rows = Array.from({ length: 50 }, () =>
      Array.from({ length: WIDE_COLUMN_COUNT }, (_, index) => String(index))
    )

    render(<SpreadsheetGrid header={header} rows={rows} columnCount={WIDE_COLUMN_COUNT} />)

    const cellCount = container!.querySelectorAll('[role="cell"]').length
    const headerCount = container!.querySelectorAll('[role="columnheader"]').length
    expect(cellCount).toBeLessThan(WIDE_COLUMN_COUNT)
    expect(headerCount).toBeLessThan(WIDE_COLUMN_COUNT)
  })

  it('keeps the row-number gutter and a heading row for a narrow sheet', () => {
    render(
      <SpreadsheetGrid
        header={['A', 'B']}
        rows={[
          ['1', '2'],
          ['3', '4']
        ]}
        columnCount={2}
      />
    )

    expect(container!.querySelector('[role="table"]')).not.toBeNull()
    // The gutter is the first columnheader, holding the '#' label.
    expect(container!.querySelector('[role="columnheader"]')?.textContent).toBe('#')
  })

  it('does not put a per-column template in the inline style of a row', () => {
    const header = Array.from({ length: WIDE_COLUMN_COUNT }, (_, index) => `C${index}`)
    const rows = [Array.from({ length: WIDE_COLUMN_COUNT }, () => 'x')]

    render(<SpreadsheetGrid header={header} rows={rows} columnCount={WIDE_COLUMN_COUNT} />)

    for (const row of container!.querySelectorAll('[role="row"]')) {
      expect(row.getAttribute('style')?.length ?? 0).toBeLessThan(2000)
    }
  })
})

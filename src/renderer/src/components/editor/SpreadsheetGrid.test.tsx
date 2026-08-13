// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpreadsheetGrid } from './SpreadsheetGrid'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Why: happy-dom reports every element as zero-sized, so the virtualizers would
// decide nothing is on screen and render no cells at all — which would let an
// assertion about cells pass against an empty document.
const VIEWPORT = { width: 800, height: 600 }

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: VIEWPORT.width,
    bottom: VIEWPORT.height,
    ...VIEWPORT,
    toJSON: () => ({})
  })
  for (const [name, value] of [
    ['clientWidth', VIEWPORT.width],
    ['clientHeight', VIEWPORT.height],
    ['offsetWidth', VIEWPORT.width],
    ['offsetHeight', VIEWPORT.height]
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

describe('SpreadsheetGrid overlay and overflow', () => {
  it('draws a sparkline once for a merged range, not once per covered row', () => {
    // Why: the merge band is painted per row, so drawing the sparkline inside the
    // cell repeated it four times down a four-row column.
    render(
      <SpreadsheetGrid
        header={['A', 'B']}
        rows={[[''], [''], [''], ['']]}
        columnCount={2}
        mergedRanges={[{ rowIndex: 0, columnIndex: 0, rowSpan: 4, columnSpan: 1 }]}
        sparklines={[
          [{ chartType: 'column', values: [1000], min: 0, max: 1500, color: '#334960' }]
        ]}
      />
    )

    expect(container!.querySelectorAll('svg[role="img"]')).toHaveLength(1)
  })

  it('lets a left-aligned label reach across empty neighbours', () => {
    render(
      <SpreadsheetGrid
        header={['A', 'B', 'C']}
        rows={[['Presupuesto mensual', '', '']]}
        columnCount={3}
      />
    )

    const cell = container!.querySelector('[role="cell"]')
    expect(cell?.className).toContain('overflow-visible')
    expect(cell?.querySelector('span')?.getAttribute('style')).toContain('max-width')
  })

  it('keeps a label clipped when the next column holds something', () => {
    render(<SpreadsheetGrid header={['A', 'B']} rows={[['Gastos', '950 €']]} columnCount={2} />)

    const cell = container!.querySelector('[role="cell"]')
    expect(cell?.className).toContain('overflow-hidden')
  })
})

describe('SpreadsheetGrid vertical merges', () => {
  function renderWithMerge(
    mergedRanges: { rowIndex: number; columnIndex: number; rowSpan: number; columnSpan: number }[]
  ): void {
    render(
      <SpreadsheetGrid
        header={['A', 'B', 'C', 'D']}
        rows={Array.from({ length: 8 }, (_, index) => [`v${index}`, '', '', ''])}
        columnCount={4}
        mergedRanges={mergedRanges}
        defaultVerticalAlignment="bottom"
      />
    )
    expect(container!.querySelectorAll('[role="cell"]').length).toBeGreaterThan(0)
  }

  function dataRows(): HTMLElement[] {
    return [...container!.querySelectorAll('[role="row"][aria-rowindex]')].filter(
      (row) => row.getAttribute('aria-rowindex') !== '1'
    ) as HTMLElement[]
  }

  it('numbers every rendered row, including the ones a merge covers', () => {
    renderWithMerge([{ rowIndex: 1, columnIndex: 0, rowSpan: 3, columnSpan: 2 }])

    const numbers = [...container!.querySelectorAll('[role="rowheader"]')].map((cell) =>
      cell.textContent?.trim()
    )
    expect(numbers).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('leaves every row in the same layer, so none can paint over another', () => {
    renderWithMerge([{ rowIndex: 1, columnIndex: 0, rowSpan: 3, columnSpan: 2 }])

    expect(dataRows().map((row) => row.style.zIndex)).toEqual(Array.from({ length: 8 }, () => ''))
  })

  it('draws the value of a row-spanning merge once, outside the rows', () => {
    renderWithMerge([{ rowIndex: 1, columnIndex: 0, rowSpan: 3, columnSpan: 2 }])

    const inCells = [...container!.querySelectorAll('[role="cell"]')].filter((cell) =>
      cell.textContent?.includes('v1')
    )
    expect(inCells).toHaveLength(0)
    expect(container!.textContent).toContain('v1')
  })

  it('leaves a merge confined to one row drawing its own value', () => {
    renderWithMerge([{ rowIndex: 1, columnIndex: 0, rowSpan: 1, columnSpan: 2 }])

    const inCells = [...container!.querySelectorAll('[role="cell"]')].filter((cell) =>
      cell.textContent?.includes('v1')
    )
    expect(inCells).toHaveLength(1)
  })
})

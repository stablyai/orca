// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SpreadsheetCell } from './SpreadsheetCell'

afterEach(cleanup)

type CellProps = Parameters<typeof SpreadsheetCell>[0]

function renderCell(overrides: Partial<CellProps> = {}): HTMLElement {
  const view = render(
    <SpreadsheetCell
      cell="Total"
      cellStyle={undefined}
      ariaColumnIndex={2}
      fontSizePx={13}
      defaultVerticalAlignment="top"
      overflowWidth={null}
      {...overrides}
    />
  )
  const cell = view.container.querySelector('[role="cell"]')
  if (cell === null) {
    throw new Error('Expected the cell to render')
  }
  return cell as HTMLElement
}

function label(cell: HTMLElement): HTMLElement {
  const span = cell.querySelector('span')
  if (span === null) {
    throw new Error('Expected the cell to hold a label')
  }
  return span
}

describe('SpreadsheetCell text clipping', () => {
  it('clips an unwrapped label with an ellipsis', () => {
    const span = label(renderCell())

    expect(span.className).toContain('truncate')
    expect(span.className).not.toContain('min-w-0')
  })

  it('lets a wrapped cell break across lines instead of clipping', () => {
    const cell = renderCell({ cellStyle: { wrapText: true } })

    expect(cell.className).toContain('py-1 whitespace-pre-wrap break-words')
    expect(label(cell).className).toContain('min-w-0')
    expect(label(cell).className).not.toContain('truncate')
  })

  it('treats wrapText false the same as a cell that declares none', () => {
    const declared = renderCell({ cellStyle: { wrapText: false } })
    const absent = renderCell()

    expect(declared.className).toBe(absent.className)
    expect(label(declared).className).toBe(label(absent).className)
  })

  it('keeps a cell without overflow inside its own box', () => {
    const cell = renderCell({ overflowWidth: null })

    expect(cell.className).toContain('overflow-hidden')
    expect(label(cell).style.maxWidth).toBe('')
    expect(label(cell).className).not.toContain('max-h-full')
  })

  it('lets a label run across empty neighbours up to the width it was given', () => {
    const cell = renderCell({ overflowWidth: 320 })

    expect(cell.className).toContain('overflow-visible')
    expect(label(cell).style.maxWidth).toBe('320px')
    expect(label(cell).className).toContain('max-h-full overflow-hidden')
  })

  it('opts a zero overflow width into the overflow rather than out of it', () => {
    const cell = renderCell({ overflowWidth: 0 })

    expect(cell.className).toContain('overflow-visible')
    expect(label(cell).style.maxWidth).toBe('0')
  })

  it('shows the same text whether or not the label may overflow', () => {
    expect(renderCell({ cell: 'Gastos', overflowWidth: 320 }).textContent).toBe('Gastos')
    expect(renderCell({ cell: 'Gastos', overflowWidth: null }).textContent).toBe('Gastos')
  })
})

describe('SpreadsheetCell colours and font', () => {
  it('keeps the theme foreground for a cell that declares only a text colour', () => {
    const cell = renderCell({ cellStyle: { textColor: '#ffffff' } })

    expect(cell.style.color).toBe('')
    expect(cell.style.backgroundColor).toBe('')
  })

  it('applies both colours a filled cell declares', () => {
    const cell = renderCell({
      cellStyle: { backgroundColor: '#000080', textColor: '#ffffff' }
    })

    expect(cell.style.backgroundColor).toBe('#000080')
    expect(cell.style.color).toBe('#ffffff')
  })

  it('fills a cell without pinning its text to an empty colour', () => {
    const cell = renderCell({ cellStyle: { backgroundColor: '#eeeeee' } })

    expect(cell.style.backgroundColor).toBe('#eeeeee')
    expect(cell.getAttribute('style')).toBe('background-color: #eeeeee;')
  })

  it('grows the font of a cell scaled above the sheet default', () => {
    expect(renderCell({ cellStyle: { fontScale: 1.5 } }).style.fontSize).toBe('20px')
  })

  it('shrinks the font of a cell scaled below the sheet default', () => {
    expect(renderCell({ cellStyle: { fontScale: 0.6 } }).style.fontSize).toBe('8px')
  })

  it('leaves the font size to the sheet when the cell declares no scale', () => {
    expect(renderCell().style.fontSize).toBe('')
  })

  it('pins the sheet font size for a cell scaled at one', () => {
    expect(renderCell({ cellStyle: { fontScale: 1 } }).style.fontSize).toBe('13px')
  })

  it('emboldens only a bold cell', () => {
    expect(renderCell({ cellStyle: { bold: true } }).className).toContain('font-semibold')
    expect(renderCell({ cellStyle: { bold: false } }).className).not.toContain('font-semibold')
  })

  it('slants only an italic cell', () => {
    expect(renderCell({ cellStyle: { italic: true } }).className).toContain('italic')
    expect(renderCell({ cellStyle: { italic: false } }).className).not.toContain('italic')
  })

  it('carries bold and italic together', () => {
    const cell = renderCell({ cellStyle: { bold: true, italic: true } })

    expect(cell.className).toContain('font-semibold')
    expect(cell.className).toContain('italic')
  })
})

describe('SpreadsheetCell borders, indent and spans', () => {
  it('replaces the gridline on the declared edge and keeps it everywhere else', () => {
    const cell = renderCell({
      cellStyle: {
        borders: { bottom: { width: '2px', style: 'solid', color: '#ff0000' } }
      }
    })

    expect(cell.style.borderBottom).toBe('2px solid #ff0000')
    expect(cell.className).toContain('border-b border-r border-spreadsheet-gridline')
  })

  it('declares no inline border for a cell that carries none', () => {
    const cell = renderCell()

    expect(cell.style.borderTop).toBe('')
    expect(cell.style.borderRight).toBe('')
    expect(cell.style.borderBottom).toBe('')
    expect(cell.style.borderLeft).toBe('')
  })

  it('indents a cell by three quarters of the font size per level', () => {
    expect(renderCell({ cellStyle: { indent: 2 } }).style.paddingLeft).toBe('20px')
  })

  it('lets the indent beat the default left padding without dropping the right one', () => {
    const cell = renderCell({ cellStyle: { indent: 2 } })

    expect(cell.className).toContain('px-2')
    expect(cell.style.paddingLeft).toBe('20px')
    expect(cell.style.paddingRight).toBe('')
  })

  it('leaves the default padding alone for an indent that means nothing', () => {
    expect(renderCell({ cellStyle: { indent: 0 } }).style.paddingLeft).toBe('')
    expect(renderCell({ cellStyle: { indent: -1 } }).style.paddingLeft).toBe('')
    expect(renderCell({ cellStyle: { indent: Number.NaN } }).style.paddingLeft).toBe('')
  })

  it('still indents a right-aligned cell', () => {
    expect(
      renderCell({ cellStyle: { indent: 3, horizontalAlignment: 'right' } }).style.paddingLeft
    ).toBe('29px')
  })

  it('stretches a merged anchor across the columns it spans', () => {
    expect(renderCell({ columnSpan: 3 }).style.gridColumn).toBe('span 3')
  })

  it('keeps a single-column span explicit', () => {
    expect(renderCell({ columnSpan: 1 }).style.gridColumn).toBe('span 1')
  })

  it('leaves the grid to place a cell that spans nothing', () => {
    expect(renderCell({ columnSpan: undefined }).style.gridColumn).toBe('')
  })

  it('carries every declared trait at once', () => {
    const cell = renderCell({
      cellStyle: {
        backgroundColor: '#000080',
        textColor: '#ffffff',
        bold: true,
        italic: true,
        fontScale: 1.5,
        borders: { bottom: { width: '2px', style: 'solid', color: '#ff0000' } },
        indent: 2,
        wrapText: true,
        verticalAlignment: 'middle'
      },
      columnSpan: 3
    })

    expect(cell.style.backgroundColor).toBe('#000080')
    expect(cell.style.color).toBe('#ffffff')
    expect(cell.style.fontSize).toBe('20px')
    expect(cell.style.borderBottom).toBe('2px solid #ff0000')
    expect(cell.style.paddingLeft).toBe('20px')
    expect(cell.style.gridColumn).toBe('span 3')
    expect(cell.className).toContain('font-semibold')
    expect(cell.className).toContain('italic')
    expect(cell.className).toContain('whitespace-pre-wrap')
    expect(cell.className).toContain('items-center')
  })

  it('leaves the shared style record it was given untouched', () => {
    const cellStyle: CellProps['cellStyle'] = {
      backgroundColor: '#eeeeee',
      indent: 2,
      borders: { bottom: { width: '2px', style: 'solid' } }
    }
    const snapshot = structuredClone(cellStyle)

    renderCell({ cellStyle })

    expect(cellStyle).toEqual(snapshot)
  })
})

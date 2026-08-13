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
      defaultVerticalAlignment="bottom"
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

function classes(cell: HTMLElement): string[] {
  return cell.className.split(' ')
}

describe('SpreadsheetCell', () => {
  it('announces itself as a grid cell', () => {
    expect(renderCell().getAttribute('role')).toBe('cell')
  })

  it('reports the column index it was given', () => {
    expect(renderCell({ ariaColumnIndex: 7 }).getAttribute('aria-colindex')).toBe('7')
  })

  it('shows the value the sheet holds', () => {
    expect(renderCell({ cell: 'Presupuesto mensual' }).textContent).toBe('Presupuesto mensual')
  })

  it('offers the whole value as a tooltip for a clipped cell', () => {
    expect(renderCell({ cell: 'Presupuesto mensual' }).getAttribute('title')).toBe(
      'Presupuesto mensual'
    )
  })

  it('still renders the box of an empty cell', () => {
    const cell = renderCell({ cell: '' })

    expect(cell.getAttribute('title')).toBe('')
    expect(cell.querySelector('span')!.textContent).toBe('')
  })

  it('keeps a line break inside the value', () => {
    expect(renderCell({ cell: 'Enero\nFebrero' }).textContent).toBe('Enero\nFebrero')
  })

  it('aligns free text to the left when the sheet declares nothing', () => {
    expect(renderCell({ cell: 'Texto' }).className).toContain('justify-start text-left')
  })

  it('aligns a number to the right when the sheet declares nothing', () => {
    expect(renderCell({ cell: '1234.5' }).className).toContain('justify-end text-right')
  })

  it('aligns a number with grouped thousands to the right', () => {
    expect(renderCell({ cell: '1.234,5' }).className).toContain('justify-end text-right')
    expect(renderCell({ cell: '1,234.50' }).className).toContain('justify-end text-right')
  })

  it('aligns a currency amount to the right', () => {
    expect(renderCell({ cell: '1.234,50 €' }).className).toContain('justify-end text-right')
    expect(renderCell({ cell: '$1,234' }).className).toContain('justify-end text-right')
  })

  it('leaves text that merely contains digits on the left', () => {
    expect(renderCell({ cell: 'Q1 2026' }).className).toContain('justify-start text-left')
    expect(renderCell({ cell: '42 kg' }).className).toContain('justify-start text-left')
  })

  it('centres a boolean and an error code when the sheet declares nothing', () => {
    expect(renderCell({ cell: 'TRUE' }).className).toContain('justify-center text-center')
    expect(renderCell({ cell: '#VALUE!' }).className).toContain('justify-center text-center')
  })

  it('lets a declared left alignment beat the number it would infer', () => {
    const cell = renderCell({
      cell: '42',
      cellStyle: { horizontalAlignment: 'left' }
    })

    expect(cell.className).toContain('justify-start')
    expect(cell.className).not.toContain('justify-end')
  })

  it('lets a declared right alignment beat the label it would infer', () => {
    expect(renderCell({ cellStyle: { horizontalAlignment: 'right' } }).className).toContain(
      'justify-end text-right'
    )
  })

  it('applies a declared centre alignment', () => {
    expect(renderCell({ cellStyle: { horizontalAlignment: 'center' } }).className).toContain(
      'justify-center text-center'
    )
  })

  it('never carries two competing horizontal alignments', () => {
    const cell = renderCell({
      cell: '42',
      cellStyle: { horizontalAlignment: 'left' }
    })

    expect(classes(cell).filter((name) => name.startsWith('justify-'))).toHaveLength(1)
    expect(
      classes(cell).filter((name) => ['text-left', 'text-right', 'text-center'].includes(name))
    ).toHaveLength(1)
  })

  it('falls back to the sheet-wide bottom alignment', () => {
    expect(renderCell({ defaultVerticalAlignment: 'bottom' }).className).toContain('items-end')
  })

  it('falls back to the sheet-wide middle alignment', () => {
    expect(renderCell({ defaultVerticalAlignment: 'middle' }).className).toContain('items-center')
  })

  it('falls back to the sheet-wide top alignment', () => {
    expect(renderCell({ defaultVerticalAlignment: 'top' }).className).toContain('items-start')
  })

  it('lets the cell pin itself to the top of a row aligned at the bottom', () => {
    expect(
      renderCell({
        cellStyle: { verticalAlignment: 'top' },
        defaultVerticalAlignment: 'bottom'
      }).className
    ).toContain('items-start')
  })

  it('lets the cell centre itself in a row aligned at the bottom', () => {
    expect(
      renderCell({
        cellStyle: { verticalAlignment: 'middle' },
        defaultVerticalAlignment: 'bottom'
      }).className
    ).toContain('items-center')
  })

  it('lets the cell sink to the bottom of a row aligned at the top', () => {
    expect(
      renderCell({
        cellStyle: { verticalAlignment: 'bottom' },
        defaultVerticalAlignment: 'top'
      }).className
    ).toContain('items-end')
  })

  it('keeps a wrapped cell centred when it says so', () => {
    const cell = renderCell({
      cellStyle: { wrapText: true, verticalAlignment: 'middle' },
      defaultVerticalAlignment: 'top'
    })

    expect(cell.className).toContain('items-center')
    expect(cell.className).toContain('whitespace-pre-wrap')
    expect(cell.className).not.toContain('items-start')
  })

  it('leaves a wrapped cell on the sheet-wide alignment when it declares none', () => {
    expect(
      renderCell({
        cellStyle: { wrapText: true },
        defaultVerticalAlignment: 'bottom'
      }).className
    ).toContain('items-end')
  })

  it('never carries two competing vertical alignments', () => {
    const cell = renderCell({
      cellStyle: { wrapText: true, verticalAlignment: 'middle' },
      defaultVerticalAlignment: 'bottom'
    })

    expect(classes(cell).filter((name) => name.startsWith('items-'))).toHaveLength(1)
  })
})

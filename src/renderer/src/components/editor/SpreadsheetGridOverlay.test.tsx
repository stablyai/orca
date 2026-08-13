// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SpreadsheetGridOverlay } from './SpreadsheetGridOverlay'
import type { SpreadsheetCellStyle } from './SpreadsheetCell'
import type {
  SpreadsheetMergedTextPlacement,
  SpreadsheetOverlayPlacements
} from './spreadsheet-grid-overlay'
import type { ResolvedXlsxSparkline } from './xlsx-sparkline'
import type { XlsxSheetDrawing } from './xlsx-drawings'

afterEach(cleanup)

type OverlayProps = Parameters<typeof SpreadsheetGridOverlay>[0]

function mergedText(
  overrides: Partial<SpreadsheetMergedTextPlacement> = {}
): SpreadsheetMergedTextPlacement {
  return {
    rowIndex: 3,
    columnIndex: 1,
    text: 'Resumen anual',
    style: undefined,
    left: 120,
    top: 64,
    width: 240,
    height: 48,
    ...overrides
  }
}

function styledMergedText(style: SpreadsheetCellStyle): SpreadsheetMergedTextPlacement {
  return mergedText({ style })
}

function imageDrawing(description?: string): XlsxSheetDrawing {
  return {
    kind: 'image',
    source: 'data:image/png;base64,AAA',
    fromRow: 0,
    fromColumn: 0,
    toRow: 1,
    toColumn: 1,
    ...(description === undefined ? {} : { description })
  }
}

function sparkline(): ResolvedXlsxSparkline {
  return { chartType: 'column', values: [1, 2, 3], min: 0, max: 3, color: '#334960' }
}

function placements(
  overrides: Partial<SpreadsheetOverlayPlacements> = {}
): SpreadsheetOverlayPlacements {
  return { drawings: [], sparklines: [], mergedTexts: [], ...overrides }
}

function renderOverlay(overrides: Partial<OverlayProps> = {}): HTMLElement {
  const view = render(
    <SpreadsheetGridOverlay
      placements={placements({ mergedTexts: [mergedText()] })}
      {...overrides}
    />
  )
  return view.container
}

function layer(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild
  if (root === null) {
    throw new Error('Expected the overlay layer to render')
  }
  return root as HTMLElement
}

function texts(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[aria-hidden]')] as HTMLElement[]
}

function onlyText(container: HTMLElement): HTMLElement {
  const found = texts(container)
  if (found.length !== 1) {
    throw new Error(`Expected one merged text, found ${found.length}`)
  }
  return found[0]!
}

function label(box: HTMLElement): HTMLElement {
  const span = box.querySelector('span')
  if (span === null) {
    throw new Error('Expected the merged text to hold a label')
  }
  return span
}

describe('SpreadsheetGridOverlay conditional rendering', () => {
  it('draws no layer over a sheet with nothing floating above it', () => {
    const container = renderOverlay({ placements: placements() })

    expect(container.firstElementChild).toBeNull()
  })

  it('draws the layer for a sheet whose only floating piece is a merged label', () => {
    const container = renderOverlay()

    expect(container.firstElementChild).not.toBeNull()
    expect(onlyText(container).textContent).toBe('Resumen anual')
  })

  it('lets the pointer through to the cells underneath', () => {
    expect(layer(renderOverlay()).classList).toContain('pointer-events-none')
  })

  it('covers the whole grid it floats over', () => {
    const root = layer(renderOverlay())

    expect(root.classList).toContain('absolute')
    expect(root.classList).toContain('inset-0')
  })
})

describe('SpreadsheetGridOverlay merged text', () => {
  it('shows the text of the merge it stands in for', () => {
    expect(onlyText(renderOverlay()).textContent).toBe('Resumen anual')
  })

  it('leaves the announcement to the anchor cell', () => {
    expect(onlyText(renderOverlay()).getAttribute('aria-hidden')).toBe('true')
  })

  it('sits on the rectangle the placement measured', () => {
    const box = onlyText(renderOverlay())

    expect(box.style.left).toBe('120px')
    expect(box.style.top).toBe('64px')
    expect(box.style.width).toBe('240px')
    expect(box.style.height).toBe('48px')
  })

  it('follows the horizontal alignment the merge declares', () => {
    const box = onlyText(
      renderOverlay({
        placements: placements({
          mergedTexts: [styledMergedText({ horizontalAlignment: 'right' })]
        })
      })
    )

    expect(box.classList).toContain('justify-end')
    expect(box.classList).toContain('text-right')
  })

  it('reads a label the reader would expect on the left', () => {
    const box = onlyText(
      renderOverlay({ placements: placements({ mergedTexts: [mergedText({ text: 'Gastos' })] }) })
    )

    expect(box.classList).toContain('justify-start')
    expect(box.classList).toContain('text-left')
  })

  it('lines a number up on the right like the column around it', () => {
    const box = onlyText(
      renderOverlay({ placements: placements({ mergedTexts: [mergedText({ text: '1.234,50' })] }) })
    )

    expect(box.classList).toContain('justify-end')
    expect(box.classList).toContain('text-right')
  })

  it('follows the vertical alignment the merge declares', () => {
    const box = onlyText(
      renderOverlay({
        placements: placements({ mergedTexts: [styledMergedText({ verticalAlignment: 'top' })] })
      })
    )

    expect(box.classList).toContain('items-start')
  })

  it('rests an undeclared label on the bottom of its band', () => {
    expect(onlyText(renderOverlay()).classList).toContain('items-end')
  })

  it('rests an undeclared label wherever the sheet puts the rest of its text', () => {
    const box = onlyText(renderOverlay({ defaultVerticalAlignment: 'middle' }))

    expect(box.classList).toContain('items-center')
    expect(box.classList).not.toContain('items-end')
  })

  it('lets the merge beat the sheet default it disagrees with', () => {
    const box = onlyText(
      renderOverlay({
        defaultVerticalAlignment: 'middle',
        placements: placements({ mergedTexts: [styledMergedText({ verticalAlignment: 'top' })] })
      })
    )

    expect(box.classList).toContain('items-start')
    expect(box.classList).not.toContain('items-center')
  })

  it('keeps a little leading between the lines of a wrapped label', () => {
    const box = onlyText(
      renderOverlay({
        placements: placements({ mergedTexts: [styledMergedText({ wrapText: true })] })
      })
    )

    expect(box.classList).toContain('leading-tight')
    expect(box.classList).not.toContain('leading-none')
    expect(box.classList).toContain('whitespace-pre-wrap')
    expect(label(box).classList).toContain('min-w-0')
    expect(label(box).classList).not.toContain('truncate')
  })

  it('clips an unwrapped label to the height of its own glyphs', () => {
    const box = onlyText(renderOverlay())

    expect(box.classList).toContain('leading-none')
    expect(box.classList).not.toContain('leading-tight')
    expect(box.classList).not.toContain('whitespace-pre-wrap')
    expect(label(box).classList).toContain('truncate')
    expect(label(box).classList).not.toContain('min-w-0')
  })

  it('inks the label in the colour the merge declares', () => {
    const box = onlyText(
      renderOverlay({
        placements: placements({ mergedTexts: [styledMergedText({ textColor: '#ffffff' })] })
      })
    )

    expect(box.style.color).toBe('#ffffff')
  })

  it('scales the label against the font size the sheet renders at', () => {
    const box = onlyText(
      renderOverlay({
        fontSizePx: 13,
        placements: placements({ mergedTexts: [styledMergedText({ fontScale: 2.4 })] })
      })
    )

    expect(box.style.fontSize).toBe('31px')
  })

  it('leaves the font size alone when the sheet never said what it renders at', () => {
    const box = onlyText(
      renderOverlay({
        placements: placements({ mergedTexts: [styledMergedText({ fontScale: 2.4 })] })
      })
    )

    expect(box.style.fontSize).toBe('')
  })

  it('leaves the font size alone for a merge that declares no scale', () => {
    expect(onlyText(renderOverlay({ fontSizePx: 13 })).style.fontSize).toBe('')
  })

  it('leaves the fill to the band of cells underneath', () => {
    const box = onlyText(
      renderOverlay({
        placements: placements({
          mergedTexts: [styledMergedText({ backgroundColor: '#000080', textColor: '#ffffff' })]
        })
      })
    )

    expect(box.style.backgroundColor).toBe('')
    expect(box.style.color).toBe('#ffffff')
  })

  it('emboldens and slants the label as the merge declares', () => {
    const box = onlyText(
      renderOverlay({
        placements: placements({ mergedTexts: [styledMergedText({ bold: true, italic: true })] })
      })
    )

    expect(box.classList).toContain('font-semibold')
    expect(box.classList).toContain('italic')
  })

  it('leaves a plain label upright', () => {
    const box = onlyText(renderOverlay())

    expect(box.classList).not.toContain('font-semibold')
    expect(box.classList).not.toContain('italic')
  })

  it('draws each of two merges without either standing in for the other', () => {
    const container = renderOverlay({
      placements: placements({
        mergedTexts: [
          mergedText({ rowIndex: 3, columnIndex: 1, text: 'Ingresos', top: 64 }),
          mergedText({ rowIndex: 9, columnIndex: 4, text: 'Gastos', top: 200 })
        ]
      })
    })
    const boxes = texts(container)

    expect(boxes.map((box) => box.textContent)).toEqual(['Ingresos', 'Gastos'])
    expect(boxes.map((box) => box.style.top)).toEqual(['64px', '200px'])
  })
})

describe('SpreadsheetGridOverlay layers together', () => {
  it('floats an anchored image beside a merged label', () => {
    const container = renderOverlay({
      placements: placements({
        mergedTexts: [mergedText()],
        drawings: [{ drawing: imageDrawing('Logo'), left: 0, top: 0, width: 80, height: 40 }]
      })
    })
    const image = container.querySelector('img')

    expect(onlyText(container).textContent).toBe('Resumen anual')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,AAA')
    expect(image?.getAttribute('alt')).toBe('Logo')
  })

  it('leaves an image without a description out of the reading order', () => {
    const container = renderOverlay({
      placements: placements({
        drawings: [{ drawing: imageDrawing(), left: 0, top: 0, width: 80, height: 40 }]
      })
    })

    expect(container.querySelector('img')?.getAttribute('alt')).toBe('')
  })

  it('floats a sparkline beside a merged label', () => {
    const container = renderOverlay({
      placements: placements({
        mergedTexts: [mergedText()],
        sparklines: [{ sparkline: sparkline(), left: 10, top: 20, width: 60, height: 16 }]
      })
    })
    const plot = container.querySelector('svg')
    if (plot === null) {
      throw new Error('Expected the sparkline to render')
    }

    expect(onlyText(container).textContent).toBe('Resumen anual')
    expect(plot.getAttribute('aria-label')).toBe('column: 1, 2, 3')
    expect((plot.parentElement as HTMLElement).style.left).toBe('10px')
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spreadsheetGridMock = vi.hoisted(() => ({
  latestProps: null as {
    header: string[]
    rows: string[][]
    columnCount: number
    cellStyles?: unknown[][]
    headerAlignment?: string
  } | null
}))

vi.mock('./SpreadsheetGrid', () => ({
  SpreadsheetGrid: (props: {
    header: string[]
    rows: string[][]
    columnCount: number
    cellStyles?: unknown[][]
    headerAlignment?: string
  }) => {
    spreadsheetGridMock.latestProps = props
    return <div data-testid="spreadsheet-grid-probe" />
  }
}))

import XlsxViewer from './XlsxViewer'
import { buildXlsxWorkbook } from './xlsx-workbook-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

// Why: parsing runs through DecompressionStream, so the workbook resolves over
// several task turns rather than a single microtask flush.
async function settleWorkbookParse(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (!container?.textContent?.includes('Loading workbook')) {
      return
    }
  }
}

async function renderWorkbook(content: string, filePath = '/repo/book.xlsx'): Promise<void> {
  await act(async () => {
    root!.render(<XlsxViewer content={content} filePath={filePath} />)
  })
  await settleWorkbookParse()
}

async function render(content: string, filePath = '/repo/book.xlsx'): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await renderWorkbook(content, filePath)
}

async function clickSheetTab(name: string): Promise<void> {
  const tab = [...container!.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent === name
  )
  expect(tab).toBeDefined()
  await act(async () => {
    ;(tab as HTMLButtonElement).click()
  })
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
  spreadsheetGridMock.latestProps = null
})

const TWO_SHEET_WORKBOOK = buildXlsxWorkbook({
  sharedStrings: ['Region', 'North'],
  sheets: [
    {
      name: 'Summary',
      sheetXml:
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>7</v></c></row>'
    },
    { name: 'Notes', sheetXml: '<row r="1"><c r="A1" t="str"><v>note</v></c></row>' }
  ]
})

describe('XlsxViewer', () => {
  it('renders every row of the first sheet under lettered columns', async () => {
    await render(toBase64(TWO_SHEET_WORKBOOK))

    expect(container?.querySelector('[data-testid="spreadsheet-grid-probe"]')).not.toBeNull()
    // Why: a workbook has no header row concept, so row 1 stays data and the
    // heading row shows the spreadsheet column letters instead.
    expect(spreadsheetGridMock.latestProps?.header).toEqual(['A', 'B'])
    expect(spreadsheetGridMock.latestProps?.rows).toEqual([
      ['Region', ''],
      ['North', '7']
    ])
    expect(spreadsheetGridMock.latestProps?.columnCount).toBe(2)
  })

  it('centers the generated column letters over their columns', async () => {
    // Why: a workbook's heading row is labels we generate, unlike a CSV's, whose
    // heading row is the file's own first row of text.
    await render(toBase64(TWO_SHEET_WORKBOOK))

    expect(spreadsheetGridMock.latestProps?.headerAlignment).toBe('center')
  })

  it('passes the sheet cell styles through to the grid', async () => {
    const bytes = buildXlsxWorkbook({
      stylesXml:
        '<styleSheet><fonts count="1"><font/></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><cellXfs count="2"><xf fillId="0"/><xf fillId="1"/></cellXfs></styleSheet>',
      sheets: [
        { name: 'Styled', sheetXml: '<row r="1"><c r="A1" s="1" t="str"><v>filled</v></c></row>' }
      ]
    })
    await render(toBase64(bytes))

    expect(spreadsheetGridMock.latestProps?.cellStyles?.[0]?.[0]).toEqual({
      backgroundColor: '#ffff00',
      textColor: '#000000'
    })
  })

  it('shows a tab per worksheet and switches the rendered sheet', async () => {
    await render(toBase64(TWO_SHEET_WORKBOOK))

    expect([...container!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'Summary',
      'Notes'
    ])

    await clickSheetTab('Notes')

    expect(spreadsheetGridMock.latestProps?.rows).toEqual([['note']])
    const selected = [...container!.querySelectorAll('[role="tab"]')].map((tab) =>
      tab.getAttribute('aria-selected')
    )
    expect(selected).toEqual(['false', 'true'])
  })

  it('reports the row and column counts of the active sheet', async () => {
    await render(toBase64(TWO_SHEET_WORKBOOK))

    expect(container?.textContent).toContain('2 rows')
    expect(container?.textContent).toContain('2 columns')

    await clickSheetTab('Notes')

    expect(container?.textContent).toContain('1 rows')
    expect(container?.textContent).toContain('1 columns')
  })

  it('marks a hidden worksheet without removing it', async () => {
    const bytes = buildXlsxWorkbook({
      sheets: [
        { name: 'Visible', sheetXml: '<row r="1"><c r="A1"><v>1</v></c></row>' },
        { name: 'Secret', sheetXml: '<row r="1"><c r="A1"><v>2</v></c></row>', hidden: true }
      ]
    })
    await render(toBase64(bytes))

    const hiddenTab = [...container!.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === 'Secret'
    )
    expect(hiddenTab?.getAttribute('title')).toContain('hidden')
  })

  it('shows an empty state for a worksheet with no rows', async () => {
    const bytes = buildXlsxWorkbook({ sheets: [{ name: 'Blank', sheetXml: '' }] })
    await render(toBase64(bytes))

    expect(container?.querySelector('[data-testid="spreadsheet-grid-probe"]')).toBeNull()
    expect(container?.textContent).toContain('Empty sheet')
  })

  it('surfaces the parse failure instead of an empty grid', async () => {
    await render(toBase64(new TextEncoder().encode('id,name\n1,a\n')))

    expect(container?.textContent).toContain('Unable to render workbook')
    expect(container?.textContent).toContain('end-of-central-directory')
    expect(container?.querySelector('[data-testid="spreadsheet-grid-probe"]')).toBeNull()
  })

  it('surfaces a base64 payload that is not decodable', async () => {
    await render('!!!not base64!!!')

    expect(container?.textContent).toContain('Unable to render workbook')
  })

  it('reloads when the content changes and keeps showing the new workbook', async () => {
    await render(toBase64(TWO_SHEET_WORKBOOK))
    await clickSheetTab('Notes')

    const replacement = buildXlsxWorkbook({
      sheets: [{ name: 'Only', sheetXml: '<row r="1"><c r="A1" t="str"><v>fresh</v></c></row>' }]
    })
    await renderWorkbook(toBase64(replacement))

    expect([...container!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'Only'
    ])
    expect(spreadsheetGridMock.latestProps?.rows).toEqual([['fresh']])
  })

  it('starts a different file on its own first sheet', async () => {
    await render(toBase64(TWO_SHEET_WORKBOOK))
    await clickSheetTab('Notes')

    const other = buildXlsxWorkbook({
      sheets: [
        { name: 'One', sheetXml: '<row r="1"><c r="A1" t="str"><v>one</v></c></row>' },
        { name: 'Two', sheetXml: '<row r="1"><c r="A1" t="str"><v>two</v></c></row>' }
      ]
    })
    await renderWorkbook(toBase64(other), '/repo/other.xlsx')

    expect(spreadsheetGridMock.latestProps?.rows).toEqual([['one']])
  })
})

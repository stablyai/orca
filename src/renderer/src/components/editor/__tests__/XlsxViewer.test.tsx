// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'

import { XlsxViewer } from '../XlsxViewer'

// Why: happy-dom rewrites import.meta.url to a document URL, so resolve from the repo root.
const FIXTURE_DIR = join(process.cwd(), 'src/renderer/src/components/editor/__tests__/fixtures')

function fixtureBase64(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name)).toString('base64')
}

// ponytail: build xlsx in-memory so the markup-cell test doesn't need a checked-in fixture.
function buildXlsxBase64(rows: string[][]): string {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'First')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })).toString('base64')
}

describe('XlsxViewer', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders three tabs for a three-sheet workbook', async () => {
    render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        content={fixtureBase64('tiny.xlsx')}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'First' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Second' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Third' })).toBeInTheDocument()
    })
  })

  it('shows first sheet content by default', async () => {
    const { container } = render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        content={fixtureBase64('tiny.xlsx')}
      />
    )
    await waitFor(() => {
      expect(screen.getByText('A1')).toBeInTheDocument()
    })
    const preview = container.querySelector('[data-testid="xlsx-preview"]')
    expect(preview).toBeTruthy()
    expect(preview?.querySelector('table')).toBeTruthy()
  })

  it('switches to the clicked sheet and renders its content', async () => {
    render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        content={fixtureBase64('tiny.xlsx')}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Third' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Third' }))
    await waitFor(() => {
      expect(screen.getByText('only-on-sheet-3')).toBeInTheDocument()
    })
  })

  it('shows a localized empty state for a sheet with no rows', async () => {
    render(
      <XlsxViewer
        filePath="/tmp/worktree/empty.xlsx"
        fileName="empty.xlsx"
        content={fixtureBase64('empty.xlsx')}
      />
    )
    await waitFor(() => {
      // ponytail: SheetJS returns "<table></table>" for an empty sheet; the
      // viewer renders an inline empty-state message above (or instead of)
      // the table so the user understands the file isn't broken.
      expect(screen.getByTestId('xlsx-empty')).toHaveTextContent(/Empty sheet/)
    })
  })

  it('shows error alert for a corrupted buffer', async () => {
    render(
      <XlsxViewer
        filePath="/tmp/worktree/bad.xlsx"
        fileName="bad.xlsx"
        content={Buffer.from([0, 1, 2, 3, 4, 5]).toString('base64')}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Unable to parse/)
    })
  })

  it('tags the first row as a header for bold/sticky styling', async () => {
    const { container } = render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        content={fixtureBase64('tiny.xlsx')}
      />
    )
    await waitFor(() => {
      expect(screen.getByText('A1')).toBeInTheDocument()
    })
    const html = container.querySelector('[data-testid="xlsx-preview"]')?.innerHTML ?? ''
    expect(html).toMatch(/<tr[^>]*class="[^"]*firstRow/)
  })

  it('escapes HTML in cell text via SheetJS escapehtml', async () => {
    const { container } = render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        content={fixtureBase64('tiny.xlsx')}
      />
    )
    await waitFor(() => {
      expect(screen.getByText('A1')).toBeInTheDocument()
    })
    // Why: SheetJS sheet_to_html runs `escapehtml` on every cell value; DOMPurify
    // is intentionally NOT used because it strips <table> in v3. The test name
    // and comment must reflect what actually sanitizes the payload.
    const html = container.querySelector('[data-testid="xlsx-preview"]')?.innerHTML ?? ''
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<iframe/i)
  })

  it('keeps literal markup in cell text without creating DOM nodes', async () => {
    const markup = '<b>not-bold</b> & <script>alert(1)</script>'
    const content = buildXlsxBase64([['Header'], [markup]])
    const { container } = render(
      <XlsxViewer filePath="/tmp/worktree/markup.xlsx" fileName="markup.xlsx" content={content} />
    )
    await waitFor(() => {
      expect(screen.getByText(markup)).toBeInTheDocument()
    })
    const preview = container.querySelector('[data-testid="xlsx-preview"]')
    expect(preview).toBeTruthy()
    // Why: escapehtml escapes angle brackets so the literal text becomes a text node; no <b>/<script> elements must appear in the preview pane.
    expect(preview?.querySelector('b')).toBeNull()
    expect(preview?.querySelector('script')).toBeNull()
  })
})

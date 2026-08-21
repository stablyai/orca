// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { XlsxViewer } from '../XlsxViewer'

// Why: happy-dom rewrites import.meta.url to a document URL, so resolve from the repo root.
const FIXTURE_DIR = join(process.cwd(), 'src/renderer/src/components/editor/__tests__/fixtures')

function fixtureBase64(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name)).toString('base64')
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
    render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        content={fixtureBase64('tiny.xlsx')}
      />
    )
    await waitFor(() => {
      expect(screen.getByText('A1')).toBeInTheDocument()
    })
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

  it('shows the CsvViewer empty state for a sheet with no rows', async () => {
    render(
      <XlsxViewer
        filePath="/tmp/worktree/empty.xlsx"
        fileName="empty.xlsx"
        content={fixtureBase64('empty.xlsx')}
      />
    )
    // Why: table rendering is delegated to CsvViewer — verify it owns the
    // empty-sheet surface so a custom empty message doesn't drift away from
    // the csv code path.
    await waitFor(() => {
      expect(screen.getByText(/Empty file/)).toBeInTheDocument()
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
      expect(screen.getByRole('alert')).toHaveTextContent(/无法解析/)
    })
  })
})

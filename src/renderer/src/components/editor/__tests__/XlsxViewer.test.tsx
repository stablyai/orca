// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent } from '@testing-library/react'

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFilePreview: vi.fn()
}))

import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import { XlsxViewer } from '../XlsxViewer'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const RUNTIME_CONTEXT = {
  settings: null,
  worktreeId: 'worktree-1',
  worktreePath: '/tmp/worktree'
}

// Why: happy-dom rewrites import.meta.url to a document URL, so resolve from the repo root.
const FIXTURE_DIR = join(process.cwd(), 'src/renderer/src/components/editor/__tests__/fixtures')

function fixtureBase64(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name)).toString('base64')
}

function mockPreview(name: string): void {
  vi.mocked(readRuntimeFilePreview).mockResolvedValue({
    content: fixtureBase64(name),
    isBinary: true,
    mimeType: XLSX_MIME
  })
}

describe('XlsxViewer', () => {
  beforeEach(() => {
    vi.mocked(readRuntimeFilePreview).mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders three tabs for a three-sheet workbook', async () => {
    mockPreview('tiny.xlsx')
    render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        runtimeContext={RUNTIME_CONTEXT}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'First' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Second' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Third' })).toBeInTheDocument()
    })
  })

  it('shows first sheet content by default', async () => {
    mockPreview('tiny.xlsx')
    render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        runtimeContext={RUNTIME_CONTEXT}
      />
    )
    await waitFor(() => {
      expect(screen.getByText('A1')).toBeInTheDocument()
    })
  })

  it('switches to the clicked sheet and renders its content', async () => {
    mockPreview('tiny.xlsx')
    render(
      <XlsxViewer
        filePath="/tmp/worktree/tiny.xlsx"
        fileName="tiny.xlsx"
        runtimeContext={RUNTIME_CONTEXT}
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

  it('shows empty message for a sheet with no rows', async () => {
    mockPreview('empty.xlsx')
    render(
      <XlsxViewer
        filePath="/tmp/worktree/empty.xlsx"
        fileName="empty.xlsx"
        runtimeContext={RUNTIME_CONTEXT}
      />
    )
    await waitFor(() => {
      expect(screen.getByText(/空 sheet/)).toBeInTheDocument()
    })
  })

  it('shows error alert for a corrupted buffer', async () => {
    vi.mocked(readRuntimeFilePreview).mockResolvedValue({
      content: Buffer.from([0, 1, 2, 3, 4, 5]).toString('base64'),
      isBinary: true,
      mimeType: XLSX_MIME
    })
    render(
      <XlsxViewer
        filePath="/tmp/worktree/bad.xlsx"
        fileName="bad.xlsx"
        runtimeContext={RUNTIME_CONTEXT}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/无法解析/)
    })
  })
})

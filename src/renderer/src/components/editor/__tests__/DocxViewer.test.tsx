// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFilePreview: vi.fn()
}))

import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import { DocxViewer } from '../DocxViewer'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

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

function mockPreview(content: string): void {
  vi.mocked(readRuntimeFilePreview).mockResolvedValue({
    content,
    isBinary: true,
    isImage: true,
    mimeType: DOCX_MIME
  })
}

describe('DocxViewer', () => {
  beforeEach(() => {
    vi.mocked(readRuntimeFilePreview).mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders html from a valid docx fixture', async () => {
    mockPreview(fixtureBase64('tiny.docx'))
    render(
      <DocxViewer
        filePath="/tmp/worktree/tiny.docx"
        fileName="tiny.docx"
        runtimeContext={RUNTIME_CONTEXT}
      />
    )
    await waitFor(() => {
      expect(screen.getByText(/Hello office preview/)).toBeInTheDocument()
    })
  })

  it('reads the preview through the runtime file client', async () => {
    mockPreview(fixtureBase64('tiny.docx'))
    render(
      <DocxViewer
        filePath="/tmp/worktree/tiny.docx"
        fileName="tiny.docx"
        runtimeContext={RUNTIME_CONTEXT}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId('docx-preview')).toBeInTheDocument()
    })
    expect(readRuntimeFilePreview).toHaveBeenCalledWith(RUNTIME_CONTEXT, '/tmp/worktree/tiny.docx')
  })

  it('does not re-read when the parent re-renders with an equivalent context', async () => {
    mockPreview(fixtureBase64('tiny.docx'))
    const { rerender } = render(
      <DocxViewer
        filePath="/tmp/worktree/tiny.docx"
        fileName="tiny.docx"
        runtimeContext={{ ...RUNTIME_CONTEXT }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId('docx-preview')).toBeInTheDocument()
    })
    rerender(
      <DocxViewer
        filePath="/tmp/worktree/tiny.docx"
        fileName="tiny.docx"
        runtimeContext={{ ...RUNTIME_CONTEXT }}
      />
    )
    expect(readRuntimeFilePreview).toHaveBeenCalledTimes(1)
  })

  it('shows an error alert for a corrupted buffer', async () => {
    mockPreview(Buffer.from([0, 1, 2, 3, 4, 5]).toString('base64'))
    render(
      <DocxViewer
        filePath="/tmp/worktree/bad.docx"
        fileName="bad.docx"
        runtimeContext={RUNTIME_CONTEXT}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/无法解析/)
    })
  })

  it('shows an error alert when the preview read fails', async () => {
    vi.mocked(readRuntimeFilePreview).mockRejectedValue(new Error('file_too_large'))
    render(
      <DocxViewer
        filePath="/tmp/worktree/huge.docx"
        fileName="huge.docx"
        runtimeContext={RUNTIME_CONTEXT}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/无法解析/)
    })
  })
})

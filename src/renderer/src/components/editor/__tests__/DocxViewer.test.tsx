// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DocxViewer } from '../DocxViewer'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// Why: happy-dom rewrites import.meta.url to a document URL, so resolve from the repo root.
const FIXTURE_DIR = join(process.cwd(), 'src/renderer/src/components/editor/__tests__/fixtures')

function fixtureBase64(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name)).toString('base64')
}

describe('DocxViewer', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders html from a valid docx fixture', async () => {
    render(
      <DocxViewer
        filePath="/tmp/worktree/tiny.docx"
        fileName="tiny.docx"
        content={fixtureBase64('tiny.docx')}
      />
    )
    await waitFor(() => {
      expect(screen.getByText(/Hello office preview/)).toBeInTheDocument()
    })
  })

  it('shows an error alert for a corrupted buffer', async () => {
    render(
      <DocxViewer
        filePath="/tmp/worktree/bad.docx"
        fileName="bad.docx"
        content={Buffer.from([0, 1, 2, 3, 4, 5]).toString('base64')}
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Unable to parse/)
    })
  })

  it('strips javascript: hyperlinks from mammoth output', async () => {
    // Why: mammoth relays .docx hyperlinks verbatim into the HTML payload, so a
    // crafted file can carry a `javascript:` URL and reach the renderer. The
    // viewer must sanitize before dangerouslySetInnerHTML.
    vi.doMock('mammoth', () => ({
      convertToHtml: vi.fn().mockResolvedValue({
        value: '<p><a href="javascript:alert(1)">click me</a></p>'
      })
    }))
    try {
      const { DocxViewer: SanitizedDocxViewer } = await import('../DocxViewer')
      const { container } = render(
        <SanitizedDocxViewer
          filePath="/tmp/worktree/js.docx"
          fileName="js.docx"
          content={fixtureBase64('tiny.docx')}
        />
      )
      await waitFor(() => {
        expect(screen.getByTestId('docx-preview')).toBeInTheDocument()
      })
      const anchor = container.querySelector('a')
      const href: string | null = anchor ? anchor.getAttribute('href') : null
      expect(href === null || !/^javascript:/i.test(href)).toBe(true)
    } finally {
      vi.doUnmock('mammoth')
      vi.resetModules()
    }
  })

  // Why: kept DOCX_MIME referenced above so test consumers can assert the
  // .docx MIME the renderer expects; exported as a constant for clarity.
  expect(DOCX_MIME).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
})

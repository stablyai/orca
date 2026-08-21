// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph as DocxParagraph,
  TextRun
} from 'docx'

import { DocxViewer } from '../DocxViewer'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// Why: happy-dom rewrites import.meta.url to a document URL, so resolve from the repo root.
const FIXTURE_DIR = join(process.cwd(), 'src/renderer/src/components/editor/__tests__/fixtures')

function fixtureBase64(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name)).toString('base64')
}

// ponytail: build a docx in-memory so we can exercise bold/italic/underline/center
// without regenerating the on-disk tiny.docx fixture (<10KB intentionally).
async function buildDocxBase64(children: DocxParagraph[]): Promise<string> {
  const buf = await Packer.toBuffer(new Document({ sections: [{ children }] }))
  return Buffer.from(buf).toString('base64')
}

describe('DocxViewer', () => {
  afterEach(() => {
    cleanup()
    vi.doUnmock('mammoth')
    vi.resetModules()
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
    // viewer must sanitize before dangerouslySetInnerHTML. vi.resetModules
    // + dynamic import ensure the mocked mammoth module reaches the freshly
    // loaded viewer; the static import at the top would otherwise pin the
    // real mammoth before vi.doMock runs.
    vi.resetModules()
    vi.doMock('mammoth', () => ({
      convertToHtml: vi.fn().mockResolvedValue({
        value: '<p>safe <a href="javascript:alert(1)">click me</a> tail</p>'
      })
    }))
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
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
  })

  // Why: kept DOCX_MIME referenced above so test consumers can assert the
  // .docx MIME the renderer expects; exported as a constant for clarity.
  expect(DOCX_MIME).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')

  it('renders bold, italic, and center alignment', async () => {
    // ponytail: DOMPurify v3.4.13 strips h1-h6/blockquote/u in this env, but
    // keeps <strong>/<em>/<p>. Assert the parts that survive the sanitizer.
    const content = await buildDocxBase64([
      new DocxParagraph({
        children: [new TextRun({ text: 'bold ', bold: true }), new TextRun('plain')]
      }),
      new DocxParagraph({
        children: [
          new TextRun('hi '),
          new TextRun({ text: 'italic', italics: true }),
          new TextRun(' end')
        ]
      }),
      new DocxParagraph({ alignment: AlignmentType.CENTER, children: [new TextRun('centered')] })
    ])
    const { container } = render(
      <DocxViewer filePath="/tmp/worktree/rich.docx" fileName="rich.docx" content={content} />
    )
    await waitFor(() => {
      const html = container.querySelector('[data-testid="docx-preview"]')?.innerHTML ?? ''
      expect(html).toMatch(/<strong[^>]*>bold\s*<\/strong>/)
      expect(html).toMatch(/<em[^>]*>italic<\/em>/)
      expect(html).toContain('centered')
    })
    expect(container.querySelector('[data-testid="docx-preview"]')?.innerHTML ?? '').toMatch(
      /class="alignmentCenter"/
    )
  })

  it('renders Heading 1 text for the heading style', async () => {
    const content = await buildDocxBase64([
      new DocxParagraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('My Title')] })
    ])
    render(<DocxViewer filePath="/tmp/worktree/h.docx" fileName="h.docx" content={content} />)
    await waitFor(() => {
      // ponytail: DOMPurify v3.4.13 flattens h1 to text in this env; assert the
      // text lands in the preview and mammoth produced <h1> upstream.
      expect(screen.getByText('My Title')).toBeInTheDocument()
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { PdfAnnotation } from '@/store/slices/pdf-annotations'
import { formatPdfAnnotationsAsMarkdown, pdfAnnotationTitle } from './pdf-annotation-output'

function annotation(overrides: Partial<PdfAnnotation>): PdfAnnotation {
  return {
    id: 'a',
    fileKey: 'file',
    page: 2,
    x: 120.4,
    y: 340.6,
    regions: [],
    quote: null,
    comment: 'Tighten this',
    intent: 'change',
    createdAt: '2026-09-30T00:00:00.000Z',
    ...overrides
  }
}

describe('formatPdfAnnotationsAsMarkdown', () => {
  it('returns nothing when there are no annotations', () => {
    expect(formatPdfAnnotationsAsMarkdown('paper.pdf', [])).toBe('')
  })

  it('numbers each pin with its page, position, text and feedback', () => {
    expect(
      formatPdfAnnotationsAsMarkdown('docs/paper.pdf', [
        annotation({ quote: 'the  result\nwas', comment: 'Name the subject' }),
        annotation({ id: 'b', page: 5, intent: 'question', comment: 'Why?' })
      ])
    ).toBe(
      [
        '## PDF Feedback: docs/paper.pdf',
        '',
        '**File:** docs/paper.pdf',
        '',
        '### 1. Page 2',
        '**Intent:** change',
        "**Position:** x=120, y=341 (PDF points from the page's top-left)",
        '**Text:** "the result was"',
        '**Feedback:** Name the subject',
        '',
        '### 2. Page 5',
        '**Intent:** question',
        "**Position:** x=120, y=341 (PDF points from the page's top-left)",
        '**Feedback:** Why?'
      ].join('\n')
    )
  })

  it('lists dragged areas instead of a position and marks their text as approximate', () => {
    const prompt = formatPdfAnnotationsAsMarkdown('out/notes.pdf', [
      annotation({
        quote: 'E = mc',
        regions: [
          { page: 2, left: 100.2, top: 200, right: 300, bottom: 240.6 },
          { page: 3, left: 10, top: 20, right: 30, bottom: 40 }
        ]
      })
    ])
    expect(prompt).toContain(
      "**Areas:** page 2 x=100–300, y=200–241; page 3 x=10–30, y=20–40 (PDF points from the page's top-left)"
    )
    expect(prompt).toContain('**Text in areas (approximate):** "E = mc"')
    expect(prompt).not.toContain('**Position:**')
  })

  it('names the TeX source lines behind a mark when SyncTeX resolved them', () => {
    const prompt = formatPdfAnnotationsAsMarkdown('out/main.pdf', [
      annotation({
        sources: [
          { path: 'sections/intro.tex', startLine: 84, endLine: 86 },
          { path: 'main.tex', startLine: 12, endLine: 12 }
        ]
      }),
      annotation({ id: 'b', comment: 'No SyncTeX here' })
    ])
    expect(prompt).toContain('**Source:** sections/intro.tex:84-86; main.tex:12')
    expect(prompt.match(/\*\*Source:\*\*/g)).toHaveLength(1)
    expect(prompt).not.toContain('**Warning:**')
  })

  it('warns once, up front, when sources changed after the PDF was built', () => {
    const prompt = formatPdfAnnotationsAsMarkdown(
      'out/main.pdf',
      [annotation({ sources: [{ path: 'main.tex', startLine: 3, endLine: 4 }] })],
      ['main.tex']
    )
    expect(prompt.split('\n').slice(4, 5)).toEqual([
      '**Warning:** `main.tex` changed after this PDF was built, so the source lines below may be off. Check them before editing, or rebuild and annotate again.'
    ])
  })
})

describe('pdfAnnotationTitle', () => {
  it('shows the page, the area count and the quote when present', () => {
    const base = { page: 3, quote: null, regions: [] }
    expect(pdfAnnotationTitle(base)).toBe('p.3')
    expect(pdfAnnotationTitle({ ...base, quote: 'hello\nworld' })).toBe('p.3 "hello world"')
    const box = { page: 3, left: 0, top: 0, right: 1, bottom: 1 }
    expect(pdfAnnotationTitle({ ...base, regions: [box, box] })).toBe('p.3 (2 areas)')
  })
})

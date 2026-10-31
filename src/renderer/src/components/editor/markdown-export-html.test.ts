import { describe, expect, it } from 'vitest'
import { buildMarkdownExportHtml } from './markdown-export-html'

describe('buildMarkdownExportHtml', () => {
  it('escapes HTML-unsafe characters in the title', () => {
    const html = buildMarkdownExportHtml({
      title: '<script>alert(1)</script>',
      renderedHtml: '<p>x</p>'
    })
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>')
    expect(html).not.toContain('<title><script>')
  })

  it('caps Mermaid SVGs at the printable page height', () => {
    const html = buildMarkdownExportHtml({ title: 'Diagram', renderedHtml: '<svg />' })

    expect(html).toContain('.orca-export-root svg { max-height: 9.5in; }')
  })
})

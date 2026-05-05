import { describe, expect, it } from 'vitest'
import { buildMarkdownExportHtml } from './markdown-export-html'

describe('buildMarkdownExportHtml', () => {
  it('wraps rendered html in a complete standalone document', () => {
    const html = buildMarkdownExportHtml({
      title: 'Hello',
      renderedHtml: '<h1>Hello</h1><p>world</p>'
    })
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8"')
    expect(html).toContain('<title>Hello</title>')
    expect(html).toContain('<h1>Hello</h1><p>world</p>')
    expect(html).toContain('class="orca-export-root"')
    expect(html).toContain('<style>')
  })

  it('escapes HTML-unsafe characters in the title', () => {
    const html = buildMarkdownExportHtml({
      title: '<script>alert(1)</script>',
      renderedHtml: '<p>x</p>'
    })
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>')
    expect(html).not.toContain('<title><script>')
  })

  it('falls back to "Untitled" when the title is empty', () => {
    const html = buildMarkdownExportHtml({ title: '', renderedHtml: '<p>x</p>' })
    expect(html).toContain('<title>Untitled</title>')
  })
})

import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownBlockquoteOrCallout, parseCallout } from './MarkdownBlockquoteOrCallout'

describe('parseCallout', () => {
  it('parses standard [!NOTE] without title', () => {
    const p = React.createElement('p', null, '[!NOTE]\nThis is a note.')
    const result = parseCallout([p])
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('note')
    expect(result?.title).toBe('Note')
  })

  it('parses [!WARNING] with a custom title', () => {
    const p = React.createElement('p', null, '[!WARNING] Watch out!\nDanger here.')
    const result = parseCallout([p])
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('warning')
    expect(result?.title).toBe('Watch out!')
  })

  it('parses [!TIP], [!IMPORTANT], and [!CAUTION]', () => {
    expect(parseCallout([React.createElement('p', null, '[!TIP] Tip title')])?.kind).toBe('tip')
    expect(parseCallout([React.createElement('p', null, '[!IMPORTANT] Important')])?.kind).toBe(
      'important'
    )
    expect(parseCallout([React.createElement('p', null, '[!CAUTION] Caution')])?.kind).toBe(
      'caution'
    )
    expect(parseCallout([React.createElement('p', null, '[!DANGER] Danger')])?.kind).toBe('caution')
  })

  it('returns null for standard blockquotes', () => {
    const p = React.createElement('p', null, 'Just a regular quote.')
    expect(parseCallout([p])).toBeNull()
  })

  it('returns null for empty blockquotes', () => {
    expect(parseCallout([])).toBeNull()
  })
})

describe('MarkdownBlockquoteOrCallout', () => {
  it('renders a styled callout container when callout syntax is present', () => {
    const p = React.createElement('p', null, '[!NOTE]\nInformational text.')
    const html = renderToStaticMarkup(React.createElement(MarkdownBlockquoteOrCallout, null, p))

    expect(html).toContain('markdown-callout markdown-callout-note')
    expect(html).toContain('markdown-callout-title')
    expect(html).toContain('Note')
    expect(html).toContain('Informational text.')
    expect(html).not.toContain('<blockquote')
  })

  it('renders standard blockquote when no callout is present', () => {
    const p = React.createElement('p', null, 'Regular blockquote text.')
    const html = renderToStaticMarkup(
      React.createElement(MarkdownBlockquoteOrCallout, { className: 'custom-quote' }, p)
    )

    expect(html).toContain('<blockquote class="custom-quote">')
    expect(html).toContain('Regular blockquote text.')
    expect(html).not.toContain('markdown-callout')
  })
})

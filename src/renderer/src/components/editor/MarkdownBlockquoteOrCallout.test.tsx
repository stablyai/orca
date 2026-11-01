import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import { MarkdownBlockquoteOrCallout, parseCallout } from './MarkdownBlockquoteOrCallout'

describe('parseCallout', () => {
  it('parses standard [!NOTE] without title', () => {
    const p = React.createElement('p', null, '[!NOTE]\nThis is a note.')
    const result = parseCallout([p])
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('note')
    expect(result?.title).toBe('Note')
    expect(result?.fold).toBeNull()
  })

  it('parses [!WARNING] with a custom title', () => {
    const p = React.createElement('p', null, '[!WARNING] Watch out!\nDanger here.')
    const result = parseCallout([p])
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('warning')
    expect(result?.title).toBe('Watch out!')
    expect(result?.fold).toBeNull()
  })

  it('parses foldable [!WARNING]- and [!TIP]+ modifiers separately from the title', () => {
    const collapsed = parseCallout([
      React.createElement('p', null, '[!WARNING]- Collapsed title\nHidden warning.')
    ])
    expect(collapsed).toMatchObject({
      kind: 'warning',
      title: 'Collapsed title',
      fold: 'closed'
    })

    const collapsedDefaultTitle = parseCallout([
      React.createElement('p', null, '[!WARNING]-\nHidden warning.')
    ])
    expect(collapsedDefaultTitle).toMatchObject({
      kind: 'warning',
      title: 'Warning',
      fold: 'closed'
    })

    const expanded = parseCallout([React.createElement('p', null, '[!TIP]+ Expanded tip\nBody.')])
    expect(expanded).toMatchObject({
      kind: 'tip',
      title: 'Expanded tip',
      fold: 'open'
    })
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

  it('renders foldable callouts using accessible <details> and <summary> elements', () => {
    const collapsedP = React.createElement('p', null, '[!WARNING]- Hidden warning\nDetails body.')
    const collapsedHtml = renderToStaticMarkup(
      React.createElement(MarkdownBlockquoteOrCallout, null, collapsedP)
    )
    expect(collapsedHtml).toContain('<details')
    expect(collapsedHtml).not.toContain('open=""')
    expect(collapsedHtml).toContain('<summary class="markdown-callout-header">')
    expect(collapsedHtml).toContain('<span class="markdown-callout-title">Hidden warning</span>')

    const expandedP = React.createElement('p', null, '[!TIP]+ Expanded tip\nTip body.')
    const expandedHtml = renderToStaticMarkup(
      React.createElement(MarkdownBlockquoteOrCallout, null, expandedP)
    )
    expect(expandedHtml).toContain('<details open=""')
    expect(expandedHtml).toContain('<summary class="markdown-callout-header">')
    expect(expandedHtml).toContain('<span class="markdown-callout-title">Expanded tip</span>')
  })

  it('parses callouts when react-markdown maps p to a custom component function', () => {
    const CustomParagraph = ({ children }: { children?: React.ReactNode }) => (
      <div className="annotated-p">
        <p>{children}</p>
      </div>
    )
    const html = renderToStaticMarkup(
      <Markdown
        components={{
          p: CustomParagraph,
          blockquote: ({ children, ...props }) => (
            <MarkdownBlockquoteOrCallout {...props}>{children}</MarkdownBlockquoteOrCallout>
          )
        }}
      >
        {' > [!IMPORTANT] Custom Title\n> Body inside custom paragraph.'}
      </Markdown>
    )

    expect(html).toContain('markdown-callout markdown-callout-important')
    expect(html).toContain('<span class="markdown-callout-title">Custom Title</span>')
    expect(html).toContain('annotated-p')
    expect(html).toContain('Body inside custom paragraph.')
  })
})

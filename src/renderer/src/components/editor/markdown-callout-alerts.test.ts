import { describe, expect, it } from 'vitest'
import { remarkCalloutAlerts } from './markdown-callout-alerts'

type Node = {
  type: string
  value?: string
  children?: Node[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

// Build the mdast a `> [!type] ...` blockquote produces with remark-breaks:
// marker line, body lines, all in one paragraph separated by `break` nodes.
function blockquote(...lines: string[]): Node {
  const children: Node[] = []
  lines.forEach((line, index) => {
    if (index > 0) {
      children.push({ type: 'break' })
    }
    children.push({ type: 'text', value: line })
  })
  return { type: 'blockquote', children: [{ type: 'paragraph', children }] }
}

// Build the mdast without remark-breaks: the marker line and body live in one
// text node separated by a raw `\n` (proves the split doesn't need break nodes).
function rawBlockquote(text: string): Node {
  return { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }] }
}

function tree(...blocks: Node[]): Node {
  return { type: 'root', children: blocks }
}

function transform(root: Node): Node {
  remarkCalloutAlerts()(root)
  return root
}

const titleText = (node: Node): string =>
  (node.children ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.value)
    .join('')

describe('remarkCalloutAlerts', () => {
  it('turns a [!note] blockquote into a callout div with a default title and body', () => {
    const bq = blockquote('[!note]', 'Body text.')
    transform(tree(bq))

    expect(bq.data?.hName).toBe('div')
    expect(bq.data?.hProperties?.className).toEqual(['md-alert', 'md-alert-note'])
    expect(bq.data?.hProperties?.role).toBe('note')
    const [title, body] = bq.children!
    expect(title.data?.hProperties?.className).toEqual(['md-alert-title'])
    expect(titleText(title)).toBe('Note')
    expect(body.type).toBe('paragraph')
    expect(titleText(body)).toBe('Body text.')
  })

  it('keeps an inline custom title (Obsidian style) and is case-insensitive', () => {
    const bq = blockquote('[!WARNING] Careful now', 'Details.')
    transform(tree(bq))

    expect(bq.data?.hProperties?.className).toEqual(['md-alert', 'md-alert-warning'])
    expect(titleText(bq.children![0])).toBe('Careful now')
    expect(titleText(bq.children![1])).toBe('Details.')
  })

  it('handles a marker-only callout with no body', () => {
    const bq = blockquote('[!caution]')
    transform(tree(bq))

    expect(bq.data?.hProperties?.className).toEqual(['md-alert', 'md-alert-caution'])
    expect(bq.children).toHaveLength(1)
    expect(titleText(bq.children![0])).toBe('Caution')
  })

  it('supports every alert type', () => {
    for (const [marker, cls] of [
      ['[!tip]', 'md-alert-tip'],
      ['[!important]', 'md-alert-important']
    ] as const) {
      const bq = blockquote(marker, 'x')
      transform(tree(bq))
      expect(bq.data?.hProperties?.className).toContain(cls)
    }
  })

  it('leaves ordinary blockquotes untouched', () => {
    const bq = blockquote('Just a normal quote.', 'Second line.')
    transform(tree(bq))
    expect(bq.data).toBeUndefined()
    expect(bq.children![0].type).toBe('paragraph')
  })

  it('ignores a bracket that is not an alert marker', () => {
    const bq = blockquote('[!unknown] not an alert')
    transform(tree(bq))
    expect(bq.data).toBeUndefined()
  })

  it('splits marker line from body on a raw newline (no remark-breaks)', () => {
    const bq = rawBlockquote('[!note]\nBody text.')
    transform(tree(bq))

    expect(bq.data?.hProperties?.className).toEqual(['md-alert', 'md-alert-note'])
    expect(titleText(bq.children![0])).toBe('Note')
    expect(bq.children![1].type).toBe('paragraph')
    expect(titleText(bq.children![1])).toBe('Body text.')
  })

  it('keeps an inline custom title before a raw newline (no remark-breaks)', () => {
    const bq = rawBlockquote('[!warning] Careful\nDetails.')
    transform(tree(bq))

    expect(bq.data?.hProperties?.className).toEqual(['md-alert', 'md-alert-warning'])
    expect(titleText(bq.children![0])).toBe('Careful')
    expect(titleText(bq.children![1])).toBe('Details.')
  })

  it('transforms callouts nested inside other containers', () => {
    const bq = blockquote('[!note]', 'nested')
    const list: Node = { type: 'listItem', children: [bq] }
    transform(tree({ type: 'list', children: [list] }))
    expect(bq.data?.hProperties?.className).toEqual(['md-alert', 'md-alert-note'])
  })
})

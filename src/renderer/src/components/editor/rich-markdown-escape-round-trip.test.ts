import { describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function createEditor(content: JSONContent | string) {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content:
      typeof content === 'string' ? encodeRawMarkdownHtmlForRichEditor(content, codec) : content,
    ...(typeof content === 'string' ? { contentType: 'markdown' as const } : {})
  })
}

function roundTrip(content: string): string {
  const editor = createEditor(content)
  try {
    editor.state.doc.check()
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function inspect(content: string | JSONContent) {
  const editor = createEditor(content)
  try {
    const types: string[] = []
    let inlineMath = 0
    let href: string | undefined
    let src: string | undefined
    let title: string | undefined
    let columns = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'inlineMath') {
        inlineMath += 1
      }
      if (node.isBlock || node.type.name === 'inlineMath' || node.type.name === 'image') {
        types.push(node.type.name)
      }
      const link = node.marks.find((mark) => mark.type.name === 'link')
      if (link && href === undefined) {
        href = typeof link.attrs.href === 'string' ? link.attrs.href : undefined
        title = typeof link.attrs.title === 'string' ? link.attrs.title : undefined
      }
      if (node.type.name === 'image' && src === undefined && typeof node.attrs.src === 'string') {
        src = node.attrs.src
      }
      if (node.type.name === 'tableRow' && columns === 0) {
        columns = node.childCount
      }
    })
    return {
      markdown: editor.getMarkdown().trimEnd(),
      types,
      inlineMath,
      text: editor.state.doc.textContent,
      href,
      src,
      title,
      columns
    }
  } finally {
    editor.destroy()
  }
}

function expectStable(source: string) {
  const once = roundTrip(source)
  expect(roundTrip(`${once}\n`)).toBe(once)
  return once
}

describe('rich markdown escape round trip', () => {
  it('keeps a heading-like paragraph a paragraph', () => {
    const once = expectStable('\\# not a heading\n')
    expect(once).toContain('\\# not a heading')
    const loaded = inspect(once)
    expect(loaded.types).toEqual(['paragraph'])
    expect(loaded.text).toBe('# not a heading')
  })

  it('escapes a paragraph whose text is only #', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '#' }] }]
    })
    try {
      expect(editor.getMarkdown()).toBe('\\#')
      const reopened = inspect(editor.getMarkdown())
      expect(reopened.types).toEqual(['paragraph'])
    } finally {
      editor.destroy()
    }
  })

  it('preserves indent on an escaped ATX-looking paragraph', () => {
    expect(expectStable('  \\# not a heading\n')).toBe('  \\# not a heading')
  })

  it('keeps escaped ordered and bullet markers as paragraphs', () => {
    expect(inspect('1\\. x\n').types).toEqual(['paragraph'])
    expect(inspect('\\- x\n').types).toEqual(['paragraph'])
    expect(expectStable('1\\. x\n')).toBe('1\\. x')
    expect(expectStable('\\- x\n')).toBe('\\- x')
  })

  it('re-escapes dollars that would become inline math', () => {
    const once = expectStable('shell \\$HOME\\$ var\n')
    expect(once).toContain('\\$')
    expect(inspect(once).inlineMath).toBe(0)
    expect(inspect('shell \\$HOME\\$ var\n').inlineMath).toBe(0)
  })

  it('does not invent a backslash on money-like $5', () => {
    expect(expectStable('cost $5\n')).toBe('cost $5')
    expect(expectStable('cost \\$5\n')).not.toContain('\\$')
    expect(inspect('cost $5\n').inlineMath).toBe(0)
  })

  it('keeps escaped dollars inside bold', () => {
    const once = expectStable('**cost \\$HOME\\$ total**\n')
    expect(inspect(once).inlineMath).toBe(0)
    expect(inspect(once).types).toEqual(['paragraph'])
  })

  it('keeps an escaped pipe as one table cell', () => {
    const source = '| a \\| b | c |\n| --- | --- |\n'
    const once = expectStable(source)
    expect(inspect(once).columns).toBe(2)
    expect(inspect(source).text.startsWith('a | b')).toBe(true)
  })

  it('escapes pipes in a cell with two block children', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'a | b' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'more | x' }] }
                  ]
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }] }]
                }
              ]
            }
          ]
        }
      ]
    })
    try {
      const markdown = editor.getMarkdown()
      expect(markdown).toContain('\\|')
      expect(inspect(`${markdown}\n`).columns).toBe(2)
    } finally {
      editor.destroy()
    }
  })

  it('repairs an attr-only unbalanced destination', () => {
    const once = expectStable('[a](b\\)c)\n')
    expect(inspect(once).href).toBe('b)c')
    expect(inspect(once).text).toBe('a')
  })

  it('escapes a dest whose paren counts are equal but nesting is not', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a',
              marks: [{ type: 'link', attrs: { href: 'a)b(c', title: null } }]
            }
          ]
        }
      ]
    })
    try {
      const markdown = editor.getMarkdown()
      expect(markdown).toContain('\\)')
      expect(inspect(`${markdown}\n`).href).toBe('a)b(c')
    } finally {
      editor.destroy()
    }
  })

  it('does not escape balanced image destinations', () => {
    const once = expectStable('![g](h(1).png)\n')
    expect(once).toContain('h(1).png')
    expect(once).not.toContain('\\(')
    expect(inspect(once).src).toBe('h(1).png')
  })

  it('escapes quotes in a title without rewriting a balanced dest', () => {
    const once = expectStable('[a](h(1).png "say \\"hi\\"")\n')
    expect(once).toContain('h(1).png')
    expect(once).not.toContain('\\(')
    expect(inspect(once).title).toBe('say "hi"')
  })

  it('escapes pipes inside link and image attributes in table cells', () => {
    const source =
      '| a | b |\n| --- | --- |\n| ![x \\| y](img.png) | [c \\| d](http://e "f \\| g") |\n'
    const once = expectStable(source)
    expect(once).toContain('![x \\| y](img.png)')
    expect(once).toContain('[c \\| d](http://e "f \\| g")')
    expect(inspect(once).columns).toBe(2)
  })

  it('does not escape dollars inside code spans', () => {
    expect(expectStable('cost `$5`\n')).toBe('cost `$5`')
  })

  it('does not rewrite real inline math delimiters', () => {
    const loaded = inspect('$x$ trailing\n')
    expect(loaded.inlineMath).toBe(1)
    expect(expectStable('$x$ trailing\n')).toContain('$x$')
  })

  it('repairs line-leading hashes next to raw HTML that contains $', () => {
    const once = expectStable('<span>$x$</span>\n\n\\# not a heading\n')
    expect(once).toContain('<span>$x$</span>')
    expect(once).not.toMatch(/<span>\\\$/)
    expect(once).toContain('\\# not a heading')
  })

  it('still repairs table pipes when the doc has a reference definition', () => {
    const source = '[ref]: ./x.md\n\n[literal][ref]\n\n| a \\| b | c |\n| --- | --- |\n'
    const once = expectStable(source)
    expect(once).toContain('\\|')
    expect(inspect(once).columns).toBe(2)
  })

  it('emits an escape for a typed-in paragraph that looks like a heading', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '# not a heading' }] }]
    })
    try {
      expect(editor.getMarkdown()).toBe('\\# not a heading')
    } finally {
      editor.destroy()
    }
  })
})

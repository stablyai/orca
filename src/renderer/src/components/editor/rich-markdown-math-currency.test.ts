import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

function create(content: string): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
}

describe('currency in rich Markdown', () => {
  it.each([
    '$10 to $20',
    '(deficit −$509,542 by end-2020), so stock basis entered 2021 at $0.',
    'Cost $5 to \\$x.',
    '$x$2',
    '$ x$',
    '$x $'
  ])('keeps %j as ordinary searchable text', (content) => {
    const editor = create(content)
    try {
      let mathCount = 0
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'inlineMath') {
          mathCount += 1
        }
      })
      expect(mathCount).toBe(0)
      expect(editor.state.doc.textContent).toBe(content.replace('\\$', '$'))
      editor.state.doc.check()
    } finally {
      editor.destroy()
    }
  })

  it.each(['E = mc^2', 'x_1', 'a +\nb', 'x\\\\'])('retains real inline math %j', (latex) => {
    const editor = create(`Formula $${latex}$ ends here.`)
    try {
      const formulas: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'inlineMath') {
          formulas.push(node.attrs.latex)
        }
      })
      expect(formulas).toEqual([latex])
      expect(editor.getMarkdown()).toContain(`$${latex}$`)
      editor.state.doc.check()
    } finally {
      editor.destroy()
    }
  })

  it.each(['Literal $x$$ suffix.', 'Literal $$x$$ suffix.'])(
    'does not close an inline formula at a double-dollar boundary in %j',
    (source) => {
      const editor = new Editor({
        element: null,
        extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }).filter(
          (extension) => extension.name !== 'blockMath'
        ),
        content: source,
        contentType: 'markdown'
      })
      try {
        const formulas: string[] = []
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'inlineMath') {
            formulas.push(node.attrs.latex)
          }
        })
        expect(formulas).toEqual([])
      } finally {
        editor.destroy()
      }
    }
  )

  it('keeps formulas after currency, display math, and code intact', () => {
    const editor = create('Cost $10 to $20, then $x_1$. Code `$5 to $10`.\n\n$$x^2$$')
    try {
      const formulas: string[] = []
      const display: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'inlineMath') {
          formulas.push(node.attrs.latex)
        }
        if (node.type.name === 'blockMath') {
          display.push(node.attrs.latex)
        }
      })
      expect(formulas).toEqual(['x_1'])
      expect(display).toEqual(['x^2'])
      expect(editor.state.doc.textContent).toContain('Code $5 to $10')
      const reopened = create(editor.getMarkdown())
      try {
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it('preserves source dollars and untouched finance paragraphs when saving an end edit', () => {
    const source = [
      '# Shareholder basis',
      '',
      '(deficit −$509,542 by end-2020), so stock basis entered 2021 at $0.',
      '',
      'Escaped: cost was \\$1,200 and the fee was \\$35. **Total: \\$1,235** due.',
      '',
      'R&D credits for Nell & Mary.',
      '',
      '| Item | Amount |',
      '|------|-------:|',
      '| Basis | $1,000 |',
      '| Distribution | \\$500 |',
      '',
      'Trailing paragraph.',
      ''
    ].join('\n')
    const editor = create(source)
    const refs = {
      originalSourceRef: { current: source },
      baseCanonicalRef: { current: editor.getMarkdown() },
      lastCommittedMarkdownRef: { current: source }
    }
    try {
      editor.view.dispatch(editor.state.tr.insertText(' Added.', editor.state.doc.content.size - 1))
      const result = commitRichMarkdownSerialization(editor, refs, (markdown) => {
        const reopened = create(markdown)
        try {
          return reopened.getMarkdown()
        } finally {
          reopened.destroy()
        }
      })
      expect(result.markdown).toBe(
        source.replace('Trailing paragraph.', 'Trailing paragraph. Added.')
      )
    } finally {
      editor.destroy()
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  exitEmptyDetailsBody,
  moveFromEmptyDetailsBodyToSummary
} from './rich-markdown-details-extension'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import { reconcileRichMarkdownBlockSource } from './rich-markdown-block-source'
import { normalizeEmptyListItems } from './rich-markdown-normalize'

{
  function createEditor(content: string | JSONContent) {
    return new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content,
      contentType: 'markdown'
    })
  }

  function firstDetailsBodyCursorPosition(editor: Editor): number {
    let position: number | null = null
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.content.size === 0) {
        const parent = editor.state.doc.resolve(pos).parent
        if (parent.type.name === 'detailsContent') {
          position = pos + 1
          return false
        }
      }

      return true
    })

    if (position === null) {
      throw new Error('Expected an empty details body paragraph')
    }

    return position
  }

  function firstTextEndPosition(editor: Editor, text: string): number {
    let position: number | null = null
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === text) {
        position = pos + text.length
        return false
      }

      return true
    })

    if (position === null) {
      throw new Error(`Expected text: ${text}`)
    }

    return position
  }

  function selectionHasAncestor(editor: Editor, typeName: string): boolean {
    const { $from } = editor.state.selection
    for (let depth = $from.depth; depth >= 0; depth -= 1) {
      if ($from.node(depth).type.name === typeName) {
        return true
      }
    }

    return false
  }

  function firstDetailsContent(editor: Editor): ProseMirrorNode {
    let content: ProseMirrorNode | null = null
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'detailsContent') {
        content = node
        return false
      }

      return true
    })

    if (!content) {
      throw new Error('Expected details content')
    }

    return content
  }

  describe('rich markdown details keyboard behavior', () => {
    it.each([
      [
        'text toggle',
        '<details><summary>Toggle</summary><p></p></details>',
        '<details class="orca-details">\n<summary>Toggle</summary>\n\n\n\n</details>'
      ],
      [
        'heading toggle',
        '<details data-orca-toggle="heading-1"><summary>Toggle</summary><p></p></details>',
        '<details class="orca-details" data-orca-toggle="heading-1">\n<summary>Toggle</summary>\n\n\n\n</details>'
      ]
    ])('moves backspace from an empty %s body to the summary', (_name, content, expected) => {
      const editor = createEditor(content)

      try {
        editor.commands.setTextSelection(firstDetailsBodyCursorPosition(editor))

        expect(moveFromEmptyDetailsBodyToSummary(editor)).toBe(true)
        expect(editor.getMarkdown().trimEnd()).toBe(expected)
        expect(editor.state.selection.$from.parent.type.name).toBe('detailsSummary')
        expect(editor.state.selection.$from.parentOffset).toBe('Toggle'.length)
      } finally {
        editor.destroy()
      }
    })

    it('does not hijack backspace when an empty first toggle body line has content after it', () => {
      const editor = createEditor({
        type: 'doc',
        content: [
          {
            type: 'details',
            attrs: { open: true, variant: null },
            content: [
              { type: 'detailsSummary', content: [{ type: 'text', text: 'Toggle' }] },
              {
                type: 'detailsContent',
                content: [
                  { type: 'paragraph' },
                  { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }
                ]
              }
            ]
          }
        ]
      })

      try {
        editor.commands.setTextSelection(firstDetailsBodyCursorPosition(editor))

        expect(moveFromEmptyDetailsBodyToSummary(editor)).toBe(false)
        expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
      } finally {
        editor.destroy()
      }
    })

    it.each([
      ['text toggle', '<details><summary>Toggle</summary><p></p></details>'],
      [
        'heading toggle',
        '<details data-orca-toggle="heading-1"><summary>Toggle</summary><p></p></details>'
      ]
    ])('exits an empty %s body on Enter', (_name, content) => {
      const editor = createEditor(content)

      try {
        editor.commands.setTextSelection(firstDetailsBodyCursorPosition(editor))

        expect(exitEmptyDetailsBody(editor)).toBe(true)
        expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
        expect(selectionHasAncestor(editor, 'detailsContent')).toBe(false)
        expect(firstDetailsContent(editor).childCount).toBe(1)
      } finally {
        editor.destroy()
      }
    })

    it('creates another paragraph inside a non-empty toggle body on Enter', () => {
      const editor = createEditor('<details><summary>Toggle</summary><p>Body</p></details>')

      try {
        editor.commands.setTextSelection(firstTextEndPosition(editor, 'Body'))

        expect(exitEmptyDetailsBody(editor)).toBe(false)
        expect(editor.commands.splitBlock()).toBe(true)
        expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
        expect(selectionHasAncestor(editor, 'detailsContent')).toBe(true)
        expect(firstDetailsContent(editor).childCount).toBe(2)
      } finally {
        editor.destroy()
      }
    })

    it('inserts a soft break inside a toggle body on Shift+Enter', () => {
      const editor = createEditor('<details><summary>Toggle</summary><p>Body</p></details>')

      try {
        editor.commands.setTextSelection(firstTextEndPosition(editor, 'Body'))

        expect(editor.commands.setHardBreak()).toBe(true)
        expect(selectionHasAncestor(editor, 'detailsContent')).toBe(true)
        expect(firstDetailsContent(editor).firstChild?.firstChild?.type.name).toBe('text')
        expect(firstDetailsContent(editor).firstChild?.child(1).type.name).toBe('hardBreak')
      } finally {
        editor.destroy()
      }
    })
  })
}

{
  it.each(['details', 'Details', 'DETAILS', 'dEtAiLs'])(
    'opens %s after prose as an editable toggle',
    (tag) => {
      const editor = new Editor({
        element: null,
        extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
        content: `Before\n<${tag}><summary>Title</summary>\n\nBody\n\n</${tag}>`,
        contentType: 'markdown'
      })
      try {
        expect(editor.state.doc.child(0).textContent).toBe('Before')
        const toggle = editor.state.doc.child(1)
        expect(toggle.type.name).toBe('details')
        expect(toggle.child(0).textContent).toBe('Title')
        expect(toggle.child(1).textContent).toBe('Body')
      } finally {
        editor.destroy()
      }
    }
  )
}

{
  function create(source: string) {
    return new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: source,
      contentType: 'markdown'
    })
  }

  it('proves the assembled document without reparsing every unchanged source block', () => {
    const source = `${Array.from(
      { length: 1000 },
      (_, index) => `Paragraph ${index} with _emphasis_.\n\n> [!NOTE]\n> - Callout ${index}\n\n`
    ).join('')}End\n`
    const editor = create(source)
    const refs = {
      originalSourceRef: { current: source },
      baseCanonicalRef: { current: editor.getMarkdown() },
      lastCommittedMarkdownRef: { current: source }
    }
    const parse = vi.spyOn(editor.markdown!, 'parse')
    let expected = source
    try {
      for (let edit = 0; edit < 3; edit++) {
        parse.mockClear()
        editor.commands.insertContentAt(1, { type: 'text', text: 'x' })
        expected = `x${expected}`
        const result = commitRichMarkdownSerialization(editor, refs, (markdown) => {
          const reopened = create(markdown)
          try {
            return reopened.getMarkdown()
          } finally {
            reopened.destroy()
          }
        })
        expect(result.markdown).toBe(expected)
        expect(parse.mock.calls.filter(([markdown]) => markdown.length > 50_000)).toHaveLength(
          edit === 0 ? 2 : 1
        )
        expect(parse.mock.calls.length).toBeLessThanOrEqual(3)
      }
    } finally {
      parse.mockRestore()
      editor.destroy()
    }
  })
}

{
  // Crash report 0e46c048: Vietnamese prose with a soft line break, an inline code
  // span and an inline image, which the markdown parser nests inside one paragraph.
  const CRASH_SOURCE =
    'Trình duyệt chỉ cho phép cài từ Web Store.\nnh `.crx` (tham chiếu, KHÔNG chặn) ![ảnh](chrome.png) và tiếp tục\n'

  function createRichMarkdownEditorFromSource(source: string): Editor {
    const codec = createRichMarkdownEditorCodec()
    return new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({
        codec,
        htmlSuperscriptLinks: true,
        htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
          sourceFilePath: '',
          worktreeId: '',
          worktreeRoot: null,
          sourceOwner: { kind: 'unknown' }
        })
      }),
      content: encodeRawMarkdownHtmlForRichEditor(source, codec, { htmlSuperscriptLinks: true }),
      contentType: 'markdown'
    })
  }

  describe('rich markdown inline images inside a paragraph', () => {
    it('parses an inline image into a schema-valid paragraph', () => {
      const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

      try {
        expect(() => editor.state.doc.check()).not.toThrow()
      } finally {
        editor.destroy()
      }
    })

    it('survives an ordinary edit in a paragraph that holds an inline image', () => {
      const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

      try {
        // Any ReplaceStep that rebuilds the paragraph runs NodeType.checkContent on
        // the reassembled content — the exact frame the crash report bottoms out in.
        expect(() => editor.view.dispatch(editor.state.tr.insertText('X', 5, 8))).not.toThrow()
      } finally {
        editor.destroy()
      }
    })

    it('round-trips the reported document without dropping the inline image', () => {
      const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

      try {
        // Why: serialization never runs NodeType.checkContent, so the markdown
        // matches byte-for-byte even when the document is schema-invalid.
        expect(() => editor.state.doc.check()).not.toThrow()
        expect(editor.getMarkdown().trimEnd()).toBe(CRASH_SOURCE.trimEnd())
      } finally {
        editor.destroy()
      }
    })

    it('keeps a standalone image inside a paragraph rather than directly under the doc', () => {
      // Upstream's paragraph parser hoists a lone image out of its paragraph, which
      // leaves an inline node as a direct child of `doc` once images are inline.
      const editor = createRichMarkdownEditorFromSource('Intro\n\n![shot](shot.png)\n\nOutro\n')

      try {
        expect(() => editor.state.doc.check()).not.toThrow()
        expect(editor.state.doc.child(1).type.name).toBe('paragraph')
      } finally {
        editor.destroy()
      }
    })

    it('keeps a markdown inline image as an inline node', () => {
      const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

      try {
        const paragraph = editor.state.doc.child(0)
        const imageIndex = [...Array(paragraph.childCount).keys()].find(
          (index) => paragraph.child(index).type.name === 'image'
        )
        expect(imageIndex).toBeDefined()
        expect(paragraph.child(imageIndex!).type.isInline).toBe(true)
      } finally {
        editor.destroy()
      }
    })
  })
}

{
  function createEditor(source: string) {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(source, codec),
      contentType: 'markdown'
    })
    normalizeEmptyListItems(editor)
    return editor
  }

  function serialize(source: string) {
    const editor = createEditor(source)
    try {
      return editor.getMarkdown()
    } finally {
      editor.destroy()
    }
  }

  const article = [
    '# Der Turing-Test',
    '',
    'Der Turing-Test ist ein Gedankenexperiment aus dem Jahr 1950.',
    '',
    '> [!wissenswert] Das Original war ein Ratespiel um Mann und Frau',
    '> In Turings Aufsatz heißt der Test "Imitation Game".',
    '',
    'Ein zweiter Absatz mit user_name_field, feature~2 und [^1].',
    '',
    '> [!zeitstrahl] 75 Jahre Imitation Game',
    '> - 1950 · Alan Turing veröffentlicht seinen Aufsatz.',
    '> - 1980 · John Searle widerspricht.',
    '',
    'Ein dritter Absatz mit *echter Betonung*.',
    '',
    '> [!achtung] Heißt „bestanden“, dass die Maschine denkt?',
    '> Nein, und das ist der Einwand von John Searle.',
    '',
    '> [!selbsttest]',
    '> - Was hat Turing mit dem Test erreichen wollen?',
    '> - Was bedeutet Intelligenz?',
    ''
  ].join('\n')

  describe('rich Markdown document source fidelity', () => {
    it.each([article, article.repeat(100), article.replaceAll('\n\n', '\n\n\n\n').repeat(60)])(
      'only changes edited prose across successive commits (%#)',
      (source) => {
        const editor = createEditor(source)
        const refs = {
          originalSourceRef: { current: source },
          baseCanonicalRef: { current: editor.getMarkdown() },
          lastCommittedMarkdownRef: { current: source }
        }
        let expected = source
        try {
          for (const text of ['1950.', '[^1].', '*echter Betonung*.']) {
            const needle = text.replace(/\*/g, '')
            let position = -1
            editor.state.doc.descendants((node, pos) => {
              if (position === -1 && node.isText && node.text?.includes(needle)) {
                position = pos + node.text.indexOf(needle) + needle.length
              }
            })
            // The final period is a separate text node after the italic mark.
            if (position === -1) {
              editor.state.doc.descendants((node, pos) => {
                if (
                  position === -1 &&
                  node.type.name === 'paragraph' &&
                  node.textContent.includes('Ein dritter')
                ) {
                  position = pos + node.nodeSize - 1
                }
              })
            }
            expect(position).toBeGreaterThan(0)
            editor.commands.insertContentAt(position, { type: 'text', text: ' rgffggf' })
            expected = expected.replace(text, `${text} rgffggf`)
            const result = commitRichMarkdownSerialization(editor, refs, serialize)
            expect(result.markdown).toBe(expected)
            const reopened = createEditor(result.markdown)
            try {
              expect(reopened.getJSON()).toEqual(editor.getJSON())
            } finally {
              reopened.destroy()
            }
          }
        } finally {
          editor.destroy()
        }
      }
    )
  })

  describe('block source reconciliation when a whole-document patch cannot be applied', () => {
    it.each([
      [
        '\n\n_Keep_\n\n\n\nEnd\n\n',
        '\n\n_Keep_\n\n\n\nChanged\n\n',
        '\n\n_Keep_\n\n\n\nChanged\n\n'
      ],
      [
        '_Keep_\n\n> [!NOTE]\n> - a\n',
        '_Keep_\n\n> [!NOTE]\n> - a\n\nAdded paragraph\n',
        '_Keep_\n\n> [!NOTE]\n> - a\n\nAdded paragraph'
      ],
      ['_Keep_\n', '_Keep_\n\nAdded paragraph', '_Keep_\n\nAdded paragraph'],
      [
        '_Keep_\n\nRemove this\n\n> [!NOTE]\n> - a\n',
        '_Keep_\n\n> [!NOTE]\n> - a\n',
        '_Keep_\n\n> [!NOTE]\n> - a\n'
      ],
      [
        '_Keep_\n\nRepeat\n\nRepeat\n\nEnd\n',
        '_Keep_\n\nRepeat\n\nChanged\n\nEnd\n',
        '_Keep_\n\nRepeat\n\nChanged\n\nEnd\n'
      ],
      ['_Keep_\r\n\r\nEnd\r\n', '_Keep_\n\nChanged', '_Keep_\r\n\r\nChanged\r\n'],
      [
        '_Keep_\n\n```text\n[] \\_ ~ ` *\n```\n\nEnd\n',
        '_Keep_\n\n```text\n[] \\_ ~ ` *\n```\n\nChanged\n',
        '_Keep_\n\n```text\n[] \\_ ~ ` *\n```\n\nChanged\n'
      ]
    ])('preserves source through structural changes (%#)', (source, changed, expected) => {
      const editor = createEditor(changed)
      try {
        const result = reconcileRichMarkdownBlockSource(
          editor,
          source,
          editor.getMarkdown(),
          serialize
        )
        expect(result).toBe(expected)
        expect(serialize(result!)).toBe(editor.getMarkdown())
      } finally {
        editor.destroy()
      }
    })
  })
}

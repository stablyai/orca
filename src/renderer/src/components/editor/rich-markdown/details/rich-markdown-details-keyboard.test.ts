import { describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  exitEmptyDetailsBody,
  moveFromEmptyDetailsBodyToSummary
} from './rich-markdown-details-extension'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { commitRichMarkdownSerialization } from '../document/rich-markdown-serialization-commit'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'

import { normalizeEmptyListItems } from '../schema/rich-markdown-normalize'

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
  })
}

{
  // Crash 0e46c048 combined Vietnamese soft-wrapped prose, code and an image in one paragraph.
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
    it('survives an ordinary edit in a paragraph that holds an inline image', () => {
      const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

      try {
        // Rebuilding the paragraph invokes NodeType.checkContent, matching the crash frame.
        expect(() => editor.view.dispatch(editor.state.tr.insertText('X', 5, 8))).not.toThrow()
      } finally {
        editor.destroy()
      }
    })

    it('round-trips the reported document without dropping the inline image', () => {
      const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

      try {
        // Serialization can match invalid documents; explicitly check schema validity too.
        expect(() => editor.state.doc.check()).not.toThrow()
        expect(editor.getMarkdown().trimEnd()).toBe(CRASH_SOURCE.trimEnd())
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
}

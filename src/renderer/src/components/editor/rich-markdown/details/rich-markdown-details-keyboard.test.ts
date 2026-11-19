import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { commitRichMarkdownSerialization } from '../document/rich-markdown-serialization-commit'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'

import { normalizeEmptyListItems } from '../schema/rich-markdown-normalize'

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

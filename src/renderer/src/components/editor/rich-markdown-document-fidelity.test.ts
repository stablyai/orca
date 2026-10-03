import { reconcileRichMarkdownBlockSource } from './rich-markdown-block-source'
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { normalizeEmptyListItems } from './rich-markdown-normalize'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

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
    ['\n\n_Keep_\n\n\n\nEnd\n\n', '\n\n_Keep_\n\n\n\nChanged\n\n', '\n\n_Keep_\n\n\n\nChanged\n\n'],
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

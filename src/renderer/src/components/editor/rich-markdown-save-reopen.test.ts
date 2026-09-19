import { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function openDocument(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
}

function canonicalize(source: string): string {
  const editor = openDocument(source)
  try {
    editor.state.doc.check()
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

const examples = [
  ['prose', '_emphasis_ and __strong__, 中文 한글 😀 café'],
  ['code', '```js\nx && y; x < y; const price = "$5"\n```\n\n` a  b `'],
  ['destinations', '[a](a\\\\b\\)) and [query](https://example.com/?a=1&b=2)'],
  ['lists', '0. first\n1. second\n\n* [x] checked\n* [ ] unchecked'],
  ['table', '| value | code |\n| :--- | ---: |\n| a \\| b | `a  b` |'],
  ['details', '<details>\n<summary>Title</summary>\n\nNested **body**.\n\n</details>'],
  ['escapes', 'cost \\$5, literal \\*stars\\*, a \\& b and &copy;'],
  ['adjacent blocks', '~~~text\n```\n~~~\n\n> quoted\n\n---']
] as const

for (const [endingName, eol] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['CR', '\r']
] as const) {
  for (const trailingNewline of [false, true]) {
    describe(`${endingName}, final newline ${trailingNewline}`, () => {
      it.each(examples)('preserves %s through edits, saves, and reopening', (_name, body) => {
        let disk = `# Edit target 0\n\n${body}${trailingNewline ? '\n' : ''}`.replace(/\n/g, eol)
        for (let revision = 0; revision < 3; revision += 1) {
          const editor = openDocument(disk)
          try {
            const canonical = editor.getMarkdown()
            const refs = {
              originalSourceRef: { current: disk },
              baseCanonicalRef: { current: canonical },
              lastCommittedMarkdownRef: { current: disk }
            }
            expect(commitRichMarkdownSerialization(editor, refs, canonicalize).markdown).toBe(disk)
            const previous = `Edit target ${revision}`
            const replacement = `Edit target ${revision + 1}`
            const heading = editor.state.doc.firstChild
            expect(heading?.textContent).toBe(previous)
            editor.view.dispatch(editor.state.tr.insertText(replacement, 1, 1 + previous.length))
            editor.state.doc.check()
            const editedCanonical = editor.getMarkdown()
            const saved = commitRichMarkdownSerialization(editor, refs, canonicalize)
            expect(saved.didSerialize).toBe(true)
            expect(saved.markdown).toBe(disk.replace(previous, replacement))
            expect(canonicalize(saved.markdown)).toBe(editedCanonical)
            expect(refs.lastCommittedMarkdownRef.current).toBe(saved.markdown)
            expect(commitRichMarkdownSerialization(editor, refs, canonicalize).markdown).toBe(
              saved.markdown
            )
            disk = saved.markdown
          } finally {
            editor.destroy()
          }
        }
      })
    })
  }
}

const editableExamples = [
  ['emphasis', 'A **target** and _untouched_.'],
  ['link label', '[target](https://example.com/?a=1&b=2)'],
  ['inline code', '` target `'],
  ['fenced code', '```ts\nconst target = 1\n```'],
  ['ordered list', '0. target\n1. untouched'],
  ['task item', '- [x] target\n- [ ] untouched'],
  ['table cell', '| value | other |\n| --- | --- |\n| target | untouched |'],
  ['details body', '<details>\n<summary>Title</summary>\n\n**target**\n\n</details>']
] as const

for (const eol of ['\n', '\r\n', '\r']) {
  for (const trailingNewline of [false, true]) {
    describe(`edits inside constructs, EOL ${JSON.stringify(eol)}, final newline ${trailingNewline}`, () => {
      it.each(editableExamples)('reopens literal text edited inside %s', (_name, body) => {
        let source = `${body}\n\nUnchanged tail.${trailingNewline ? '\n' : ''}`.replace(/\n/g, eol)
        let previous = 'target'
        for (const replacement of ['中文 😀', '**literal** &copy;', '[label](path) $5', 'final']) {
          const editor = openDocument(source)
          try {
            const refs = {
              originalSourceRef: { current: source },
              baseCanonicalRef: { current: editor.getMarkdown() },
              lastCommittedMarkdownRef: { current: source }
            }
            let position: number | undefined
            editor.state.doc.descendants((node, offset) => {
              const index = node.isTextblock ? node.textContent.indexOf(previous) : undefined
              if (index !== undefined && index >= 0) {
                position = offset + 1 + index
              }
            })
            expect(position).toBeDefined()
            if (position === undefined) {
              throw new Error('missing edit target')
            }
            editor.view.dispatch(
              editor.state.tr.insertText(replacement, position, position + previous.length)
            )
            const expectedText = editor.state.doc.textContent
            const expectedMarkdown = editor.getMarkdown()
            const saved = commitRichMarkdownSerialization(editor, refs, canonicalize)
            const reopened = openDocument(saved.markdown)
            try {
              reopened.state.doc.check()
              expect(reopened.state.doc.textContent).toBe(expectedText)
              expect(reopened.getMarkdown()).toBe(expectedMarkdown)
              expect(saved.markdown).toContain('Unchanged tail.')
              expect(commitRichMarkdownSerialization(editor, refs, canonicalize).markdown).toBe(
                saved.markdown
              )
            } finally {
              reopened.destroy()
            }
            previous = replacement
            source = saved.markdown
          } finally {
            editor.destroy()
          }
        }
      })
    })
  }
}

for (const eol of ['\n', '\r\n', '\r']) {
  it.each(['null', 'throw'])(
    `recovers after a %s reconciliation failure with EOL ${JSON.stringify(eol)}`,
    (failure) => {
      const source = '# target\n\n_unchanged_\n'.replace(/\n/g, eol)
      const editor = openDocument(source)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const refs = {
          originalSourceRef: { current: source },
          baseCanonicalRef: { current: editor.getMarkdown() },
          lastCommittedMarkdownRef: { current: source }
        }
        editor.view.dispatch(editor.state.tr.insertText('changed', 1, 7))
        const saved = commitRichMarkdownSerialization(editor, refs, () => {
          if (failure === 'throw') {
            throw new Error('Injected round-trip failure')
          }
          return null
        })
        expect(canonicalize(saved.markdown)).toBe(editor.getMarkdown())
        expect(saved.markdown.endsWith(eol)).toBe(true)
        expect(refs.lastCommittedMarkdownRef.current).toBe(saved.markdown)
        const serialize = vi.spyOn(editor, 'getMarkdown').mockImplementationOnce(() => {
          throw new Error('Injected editor teardown')
        })
        expect(commitRichMarkdownSerialization(editor, refs, canonicalize)).toEqual({
          markdown: saved.markdown,
          didSerialize: false
        })
        serialize.mockRestore()
        editor.view.dispatch(editor.state.tr.insertText('recovered', 1, 8))
        const recovered = commitRichMarkdownSerialization(editor, refs, canonicalize)
        expect(recovered.didSerialize).toBe(true)
        expect(canonicalize(recovered.markdown)).toBe(editor.getMarkdown())
        expect(recovered.markdown).toContain('recovered')
      } finally {
        consoleError.mockRestore()
        editor.destroy()
      }
    }
  )
}

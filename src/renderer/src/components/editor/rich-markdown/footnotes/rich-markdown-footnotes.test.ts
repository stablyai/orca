// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from '../../markdown/render-mode/markdown-rich-mode'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'
import { commitRichMarkdownSerialization } from '../document/rich-markdown-serialization-commit'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { normalizeEmptyListItems } from '../schema/rich-markdown-normalize'

const TEST_KEY = '0123456789abcdef0123456789abcdef'

function createEditor(content: string, element: HTMLElement | null = null): Editor {
  const codec = createRichMarkdownEditorCodec(TEST_KEY)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({
      codec,
      htmlSuperscriptLinks: true,
      htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '/repo/README.md',
        worktreeId: 'worktree-1',
        worktreeRoot: '/repo',
        sourceOwner: { kind: 'local' }
      })
    }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec, { htmlSuperscriptLinks: true }),
    contentType: 'markdown'
  })
  normalizeEmptyListItems(editor)
  return editor
}

function serializeSource(source: string): string {
  const editor = createEditor(source)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

function collectFootnoteNodes(editor: Editor): { refs: string[]; defs: string[] } {
  const refs: string[] = []
  const defs: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'richMarkdownFootnoteReference') {
      refs.push(String(node.attrs.identifier ?? ''))
    } else if (node.type.name === 'richMarkdownFootnoteDefinition') {
      defs.push(String(node.attrs.identifier ?? ''))
    }
  })
  return { refs, defs }
}

function findTextPosition(editor: Editor, needle: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(needle)) {
      found = pos + node.text.indexOf(needle)
    }
  })
  if (found === -1) {
    throw new Error(`Missing text: ${needle}`)
  }
  return found
}

const LARGE_PADDING = 'Standard paragraph prose without footnotes.\n\n'.repeat(1_200)

describe('rich Markdown GFM footnotes', () => {
  it('admits standard GFM footnotes and preserves them across body and footnote edits', () => {
    const source = [
      'Body claim[^1] and tight refs[^2][^3].',
      '',
      'Note[^Note]: mid-line colon stays prose.',
      '',
      '[^1]: Single-line with [Orca](https://example.com) and `code`.',
      '[^2]: https://example.com/docs',
      '[^3]: Nested reference to [^multi].',
      '',
      '[^multi]: First paragraph.',
      '',
      '    Second paragraph with `[^1]`.',
      '',
      '    ```ts',
      '    const raw = "[^1]"',
      '    ```',
      '',
      '[^note]: Case-insensitive target.',
      '[^unused]: Unreferenced footnote definition.'
    ].join('\n')

    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()

    const editor = createEditor(source)
    const refs = {
      originalSourceRef: { current: source },
      baseCanonicalRef: { current: editor.getMarkdown() },
      lastCommittedMarkdownRef: { current: source }
    }
    try {
      editor.state.doc.check()
      expect(collectFootnoteNodes(editor)).toEqual({
        refs: ['1', '2', '3', 'Note', 'multi'],
        defs: ['1', '2', '3', 'multi', 'note', 'unused']
      })

      const bodyPos = findTextPosition(editor, 'Body claim')
      editor.view.dispatch(editor.state.tr.insertText('Updated ', bodyPos, bodyPos))
      const afterBodyEdit = commitRichMarkdownSerialization(editor, refs, serializeSource)
      expect(afterBodyEdit.didSerialize).toBe(true)
      expect(afterBodyEdit.markdown).toBe(source.replace('Body claim', 'Updated Body claim'))

      const notePos = findTextPosition(editor, 'First paragraph.')
      editor.view.dispatch(editor.state.tr.insertText('Edited ', notePos, notePos))
      const afterFootnoteEdit = commitRichMarkdownSerialization(editor, refs, serializeSource)
      expect(afterFootnoteEdit.markdown).toBe(
        source
          .replace('Body claim', 'Updated Body claim')
          .replace('First paragraph.', 'Edited First paragraph.')
      )

      const reopened = createEditor(afterFootnoteEdit.markdown)
      try {
        reopened.state.doc.check()
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it.each([
    ['large document with a footnote', `${LARGE_PADDING}End[^big].\n\n[^big]: Note.\n`, null],
    [
      'large document with a reference definition inside a footnote',
      `${LARGE_PADDING}End[^big].\n\n[^big]:\n    [ref]: https://example.com\n`,
      'reference-links'
    ],
    [
      'large document with a malformed footnote',
      `${LARGE_PADDING}End[^big].\n\n[^big]:no-space\n`,
      'footnotes'
    ],
    ['malformed definition', 'Text[^1].\n\n[^1]:no-space-after-colon\n', 'footnotes'],
    [
      'malformed definition after a closed quoted fence',
      '> ````md\n> ```\n> ````\n\nText[^1].\n\n[^1]:no-space-after-colon\n',
      'footnotes'
    ],
    [
      'malformed definition after indented code that looks like a fence',
      '    ```\n\nText[^1].\n\n[^1]:no-space-after-colon\n',
      'footnotes'
    ],
    [
      'malformed definition after a fence marker inside an HTML comment',
      '<!--\n```-->\n\n[^1]:no-space-after-colon\n',
      'footnotes'
    ],
    ['list fence closed by leaving the list', '- ~~~\n  code\n\n[^n]:no-space\n', 'footnotes'],
    [
      'quoted list fence closed by the quote',
      '> - ~~~\n>   code\n>\n> [^n]:no-space\n',
      'footnotes'
    ],
    [
      'tab-indented quoted fence closer',
      '> ~~~\n> code\n>\t~~~\n>\n> [^n]:no-space\n',
      'footnotes'
    ],
    ['thematic break is not a list', '* * *\n    ~~~\n  [^n]:no-space\n', 'footnotes'],
    [
      'unclosed quoted HTML comment ends with the quote',
      '> <!--\n\n[^n]:no-space\n\n<!-- tail -->\n',
      'footnotes'
    ],
    [
      'footnote-shaped text inside an HTML comment',
      'Body[^ghost] and [^1].\n\n<!--\n[^ghost]: hidden\n-->\n\n[^1]: Real.\n',
      null
    ],
    [
      'code span closing an HTML comment',
      '<!-- opening `demo`\nline --> `[^fake]`\n\nText[^1].\n\n[^1]: Valid note.\n',
      null
    ],
    ['identifier with a space', '[^has space]: https://example.com\n', 'reference-links'],
    [
      'footnote beside a reference definition',
      'Body[^1].\n\n[^1]: Real footnote.\n\n[ref]: https://example.com\n',
      'reference-links'
    ]
  ])('rich mode eligibility: %s', (_name, source, expected) => {
    expect(getMarkdownRichModeUnsupportedReason(source)).toBe(expected)
  })

  it('keeps unindented prose outside footnotes and skips definitions inside HTML comments', () => {
    const indentedEditor = createEditor('Body[^n].\n\n[^n]:\n        code\nOutside paragraph.\n')
    try {
      const topLevelTypes: string[] = []
      indentedEditor.state.doc.forEach((child) => {
        topLevelTypes.push(child.type.name)
      })
      expect(topLevelTypes).toEqual(['paragraph', 'richMarkdownFootnoteDefinition', 'paragraph'])
      expect(indentedEditor.state.doc.lastChild?.textContent).toBe('Outside paragraph.')
    } finally {
      indentedEditor.destroy()
    }

    const commentEditor = createEditor(
      'Body[^ghost] and [^1].\n\n<!--\n[^ghost]: hidden\n-->\n\n[^1]: Real.\n'
    )
    try {
      expect(collectFootnoteNodes(commentEditor)).toEqual({ refs: ['1'], defs: ['1'] })
      expect(commentEditor.state.doc.firstChild?.textContent).toContain('[^ghost]')
    } finally {
      commentEditor.destroy()
    }
  })

  it('ignores code blocks, inline code, escapes, undefined refs, and inline links shaped like footnotes', () => {
    const source = [
      'Keep \\[^1], [^missing], `[^1]`, and [^1](https://example.com) beside [^1].',
      '',
      '```md',
      '[^1] and [^fake]: inside fenced code',
      '```',
      '',
      '> ```md',
      '> [^quoted-fake]: inside quoted fence',
      '> ```',
      '',
      '[^1]: Only real footnote.'
    ].join('\n')

    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
    const editor = createEditor(source)
    try {
      expect(collectFootnoteNodes(editor)).toEqual({ refs: ['1'], defs: ['1'] })
      const links: string[] = []
      editor.state.doc.descendants((node) => {
        for (const mark of node.marks) {
          if (mark.type.name === 'link') {
            links.push(`${node.text}:${String(mark.attrs.href)}`)
          }
        }
      })
      expect(links).toEqual(['^1:https://example.com'])
      expect(editor.state.doc.firstChild?.textContent).toContain('[^missing]')
      expect(editor.getMarkdown()).toContain('[^1](https://example.com)')

      const reopened = createEditor(editor.getMarkdown())
      try {
        expect(collectFootnoteNodes(reopened)).toEqual({ refs: ['1'], defs: ['1'] })
        expect(reopened.state.doc.firstChild?.textContent).toContain('[^missing]')
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it('round-trips footnote references and definitions through clipboard HTML', () => {
    const source = 'Copy me[^1].\n\n[^1]: Preserved note.'
    const editor = createEditor(source, document.createElement('div'))
    try {
      const html = editor.view.serializeForClipboard(
        editor.state.doc.slice(0, editor.state.doc.content.size)
      ).dom.innerHTML
      const pasted = createEditor('')
      try {
        pasted.commands.setContent(html, { contentType: 'html' })
        expect(collectFootnoteNodes(pasted)).toEqual({ refs: ['1'], defs: ['1'] })
        expect(pasted.getMarkdown()).toBe(source)
      } finally {
        pasted.destroy()
      }
    } finally {
      editor.destroy()
    }
  })
})

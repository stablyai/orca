// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import * as fenceScanner from './markdown-fence-scanner'

function createEditor(source: string): Editor {
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

it.each([200, 50_000, 50_001])(
  'preserves anchors and editable tables at %i characters',
  (length) => {
    const suffix =
      '\n\n<a id="section"></a>\n\n## Section\n\n| Issue | State |\n| --- | --- |\n| [Report](https://example.com) | OPEN |\n'
    const source = 'a'.repeat(length - suffix.length) + suffix
    expect(source).toHaveLength(length)
    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
    const editor = createEditor(source)
    const refs = {
      originalSourceRef: { current: source },
      baseCanonicalRef: { current: editor.getMarkdown() },
      lastCommittedMarkdownRef: { current: source }
    }
    try {
      editor.state.doc.check()
      const anchor = editor.state.doc.child(1)
      expect(anchor.type.name).toBe('paragraph')
      expect(anchor.childCount).toBe(2)
      expect(anchor.textBetween(0, anchor.content.size, '', (node) => node.attrs.value)).toBe(
        '<a id="section"></a>'
      )
      let position = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'OPEN') {
          position = pos
        }
      })
      expect(position).toBeGreaterThan(0)
      editor.commands.insertContentAt({ from: position, to: position + 4 }, 'CLOSED')
      const result = commitRichMarkdownSerialization(editor, refs, (markdown) => {
        const reopened = createEditor(markdown)
        try {
          return reopened.getMarkdown()
        } finally {
          reopened.destroy()
        }
      })
      expect(result.markdown.startsWith(source.slice(0, source.indexOf('| Issue')))).toBe(true)
      expect(result.markdown).toContain('CLOSED')
      const reopened = createEditor(result.markdown)
      try {
        reopened.state.doc.check()
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  }
)

it.each([
  '    <span>indented</span>',
  '[link](https://example.com "<span>title</span>")',
  '[link](<span>)'
])('blocks markup that the parser keeps as transport text: %s', (markup) => {
  for (const length of [200, 50_000, 50_001, 120_000]) {
    const source = `${'a'.repeat(length)}\n\n${markup}\n`
    expect(getMarkdownRichModeUnsupportedReason(source)).toBe('html-or-jsx')
  }
})

it('preserves markup in the edited paragraph through successive saves and reopening', () => {
  const markup = '<span title="keep">text</span> <sup><a href="https://example.com">1</a></sup>'
  const source = `${'a'.repeat(50_001)}\n\nBefore ${markup} after\n`
  expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
  const editor = createEditor(source)
  const refs = {
    originalSourceRef: { current: source },
    baseCanonicalRef: { current: editor.getMarkdown() },
    lastCommittedMarkdownRef: { current: source }
  }
  let expected = source
  try {
    for (const [search, replacement] of [
      ['Before', 'Changed'],
      ['after', 'tail']
    ]) {
      let position = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text?.includes(search)) {
          position = pos + node.text.indexOf(search)
        }
      })
      expect(position).toBeGreaterThan(0)
      editor.commands.insertContentAt(
        { from: position, to: position + search.length },
        { type: 'text', text: replacement }
      )
      expected = expected.replace(search, replacement)
      const result = commitRichMarkdownSerialization(editor, refs, (markdown) => {
        const reopened = createEditor(markdown)
        try {
          return reopened.getMarkdown()
        } finally {
          reopened.destroy()
        }
      })
      expect(result.markdown).toBe(expected)
      expect(result.markdown).not.toContain('ORCA_RICH_MD:')
      const reopened = createEditor(result.markdown)
      try {
        reopened.state.doc.check()
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        reopened.destroy()
      }
    }
  } finally {
    editor.destroy()
  }
})

it('scans whole-document fence ranges once for thousands of passthrough details blocks', () => {
  const source = '<details class="custom"><summary>Toggle</summary>Body</details>\n\n'.repeat(4_000)
  const scan = vi.spyOn(fenceScanner, 'getMarkdownFenceRanges')
  try {
    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
    expect(scan.mock.calls.filter(([content]) => content === source)).toHaveLength(1)
  } finally {
    scan.mockRestore()
  }
})

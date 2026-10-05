// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Fragment, Slice } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { serializeRichMarkdownSliceToMarkdown } from './rich-markdown-clipboard-markdown-text'

const editors: Editor[] = []
const FIXTURE = [
  '# Heading One',
  '',
  'A paragraph with **bold text**, `inline code`, and a [link](https://example.com/target).',
  '',
  'Second paragraph.',
  '',
  '- First bullet',
  '- Second bullet',
  '  - Nested bullet',
  '',
  '7. First numbered',
  '8. Second numbered',
  '9. Third numbered',
  '',
  '> A quote with **marked text**',
  '',
  '```ts',
  'const answer = "**literal**";',
  'secondCodeLine();',
  '```',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| Alice | 42 |',
  '| Bob | 43 |'
].join('\n')

function createEditor(markdown = FIXTURE): Editor {
  const codec = createRichMarkdownEditorCodec()
  let editor: Editor | null = null
  editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(markdown, codec),
    contentType: 'markdown',
    editorProps: {
      clipboardTextSerializer: (slice, view) =>
        serializeRichMarkdownSliceToMarkdown(editor, slice, view.state.selection.$from)
    }
  })
  editors.push(editor)
  return editor
}

function textPos(editor: Editor, text: string): number {
  let found: number | undefined
  editor.state.doc.descendants((node, pos) => {
    if (found === undefined && node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text)
    }
  })
  if (found === undefined) {
    throw new Error(`Fixture text missing: ${text}`)
  }
  return found
}

function copyRange(editor: Editor, anchor: number, head: number) {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head))
  )
  return editor.view.serializeForClipboard(editor.state.selection.content())
}

function copyText(editor: Editor, text: string): string {
  const from = textPos(editor, text)
  return copyRange(editor, from, from + text.length).text
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('rich Markdown native clipboard slices', () => {
  it('keeps headings, marks, links, list nesting, fences, and tables in a full copy', () => {
    const editor = createEditor()
    editor.commands.selectAll()
    const copied = editor.view.serializeForClipboard(editor.state.selection.content())
    expect(copied.text).toContain('# Heading One\n\nA paragraph with **bold text**')
    expect(copied.text).toContain('`inline code`')
    expect(copied.text).toContain('[link](https://example.com/target)')
    expect(copied.text).toContain('- First bullet\n- Second bullet\n  - Nested bullet')
    expect(copied.text).toContain('7. First numbered\n8. Second numbered\n9. Third numbered')
    expect(copied.text).toContain('```ts\nconst answer = "**literal**";\nsecondCodeLine();\n```')
    expect(copied.text).toContain('| Alice | 42')
    expect(copied.text).not.toContain('bullet\n\n\n')
  })

  it.each([
    ['bold text', '**bold text**'],
    ['inline code', '`inline code`'],
    ['link', '[link](https://example.com/target)'],
    ['Heading', 'Heading'],
    ['marked text', '**marked text**'],
    ['First bullet', 'First bullet'],
    ['Second numbered', 'Second numbered'],
    ['**literal**', '**literal**']
  ])('copies selected %s without unselected block syntax', (text, expected) => {
    expect(copyText(createEditor(), text)).toBe(expected)
  })

  it('retains code-block syntax when its outer boundaries are selected', () => {
    const editor = createEditor()
    let from: number | undefined
    editor.state.doc.forEach((node, pos) => {
      if (node.type.name === 'codeBlock') {
        from = pos
      }
    })
    if (from === undefined) {
      throw new Error('Fixture code block missing')
    }
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, from)))
    expect(editor.view.serializeForClipboard(editor.state.selection.content()).text).toBe(
      '```ts\nconst answer = "**literal**";\nsecondCodeLine();\n```'
    )
  })

  it('copies backwards selections identically', () => {
    const editor = createEditor()
    const from = textPos(editor, 'bold text')
    expect(copyRange(editor, from + 9, from).text).toBe('**bold text**')
    expect(editor.state.selection.anchor).toBeGreaterThan(editor.state.selection.head)
  })

  it('joins paragraphs with one blank line', () => {
    const editor = createEditor()
    const from = textPos(editor, 'bold text')
    const to = textPos(editor, 'Second paragraph.') + 'Second paragraph.'.length
    expect(copyRange(editor, from, to).text).toBe(
      '**bold text**, `inline code`, and a [link](https://example.com/target).\n\nSecond paragraph.'
    )
  })

  it('retains the first selected ordered-list number in both directions', () => {
    const editor = createEditor()
    const from = textPos(editor, 'Second numbered')
    const to = textPos(editor, 'Third numbered') + 'Third numbered'.length
    expect(copyRange(editor, from, to).text).toBe('8. Second numbered\n9. Third numbered')
    expect(copyRange(editor, to, from).text).toBe('8. Second numbered\n9. Third numbered')
  })

  it('copies a selected ordered-list node with its owner number', () => {
    const editor = createEditor()
    let pos: number | undefined
    editor.state.doc.descendants((node, offset) => {
      if (node.type.name === 'listItem' && node.textContent === 'Second numbered') {
        pos = offset
      }
    })
    if (pos === undefined) {
      throw new Error('Fixture list item missing')
    }
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
    expect(editor.view.serializeForClipboard(editor.state.selection.content()).text).toBe(
      '8. Second numbered'
    )
  })

  it('does not wrap a transformed foreign item with the selected node owner', () => {
    const editor = createEditor()
    const from = textPos(editor, 'Second numbered') - 2
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, from)))
    const foreign = editor.schema.nodes.listItem.create(
      null,
      editor.schema.nodes.paragraph.create(null, editor.schema.text('Foreign item'))
    )
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        transformCopied: () => new Slice(Fragment.from(foreign), 0, 0)
      }
    })
    expect(editor.view.serializeForClipboard(editor.state.selection.content()).text).toBe(
      '- Foreign item'
    )
  })

  it('preserves nested ordered-list starts', () => {
    const editor = createEditor(
      '1. Outer\n   7. First nested\n   8. Second nested\n   9. Third nested'
    )
    const from = textPos(editor, 'Second nested')
    const to = textPos(editor, 'Third nested') + 'Third nested'.length
    const text = copyRange(editor, from, to).text
    expect(text).toBe('8. Second nested\n9. Third nested')
    expect(text).not.toContain('First nested')
  })

  it('keeps a nested list separate from its open outer marker when later outer siblings are selected', () => {
    const editor = createEditor('1. Outer\n   7. First nested\n   8. Second nested\n2. Other outer')
    const text = copyRange(
      editor,
      textPos(editor, 'Second nested'),
      textPos(editor, 'Other outer') + 'Other outer'.length
    ).text
    expect(text).toContain('1. \n')
    expect(text).toContain('8. Second nested')
    expect(text).toContain('2. Other outer')
    expect(text).not.toContain('1. 8.')
    expect(text).not.toContain('First nested')
  })

  it('uses empty table headers for a body-only selection without adding unselected text', () => {
    const editor = createEditor()
    const text = copyRange(editor, textPos(editor, 'Alice'), textPos(editor, '43') + 2).text
    expect(text).toContain('| Alice | 42')
    expect(text).toContain('| Bob')
    expect(text).toContain('| ----- | --- |')
    expect(text).not.toContain('Name')
    expect(text).not.toContain('Value')
  })

  it('keeps source-owning content out of editor transport placeholders', () => {
    const editor = createEditor(
      '<div data-fixture="owned">Raw HTML</div>\n\n![fixture](https://example.com/fixture.png)\n\nfile_name [literal]'
    )
    editor.commands.selectAll()
    const copied = editor.view.serializeForClipboard(editor.state.selection.content())
    expect(copied.text).toContain('<div data-fixture="owned">Raw HTML</div>')
    expect(copied.text).toContain('![fixture](https://example.com/fixture.png)')
    expect(copied.text).not.toContain('ORCA_RICH_MD')
    const parsed = editor.markdown?.parse(copied.text)
    expect(parsed?.content?.some((node) => node.type === 'paragraph')).toBe(true)
  })

  it('preserves HTML metadata and marks exactly as the default serializer does', () => {
    const editor = createEditor()
    const copied = copyRange(editor, textPos(editor, 'bold text'), textPos(editor, 'bold text') + 9)
    editor.setOptions({ editorProps: { clipboardTextSerializer: undefined } })
    const baseline = editor.view.serializeForClipboard(editor.state.selection.content())
    expect(copied.dom.innerHTML).toBe(baseline.dom.innerHTML)
    expect(copied.dom.innerHTML).toContain('data-pm-slice=')
    expect(copied.dom.innerHTML).toContain('<strong>bold text</strong>')
  })

  it('honors transformed clipboard content rather than recopying the live document', () => {
    const editor = createEditor()
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        transformCopied: () =>
          new Slice(
            Fragment.from(
              editor.schema.nodes.paragraph.create(
                null,
                editor.schema.text('Transformed **literal**')
              )
            ),
            1,
            1
          )
      }
    })
    expect(copyText(editor, 'bold text')).toBe(String.raw`Transformed \*\*literal\*\*`)
  })

  it('retains the existing plain-text fallback without a Markdown manager', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit],
      content: '<p>first</p><p>second</p>'
    })
    editors.push(editor)
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size)
    expect(serializeRichMarkdownSliceToMarkdown(editor, slice, editor.state.doc.resolve(1))).toBe(
      'first\n\nsecond'
    )
    expect(serializeRichMarkdownSliceToMarkdown(null, slice, editor.state.doc.resolve(1))).toBe(
      'first\n\nsecond'
    )
  })
})

// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  getRichMarkdownSliceSerializer,
  serializeRichMarkdownSliceToMarkdown
} from './rich-markdown-clipboard-markdown-text'

const FIXTURE = [
  '# Heading One',
  '',
  'A paragraph with **bold text** and `inline code` and a [link](https://example.com/target).',
  '',
  '- First bullet',
  '- Second bullet',
  '  - Nested bullet',
  '',
  '```ts',
  'const answer = 42',
  'console.log(answer)',
  '```'
].join('\n')

function createEditor(markdown: string): Editor {
  return new Editor({
    element: null,
    extensions: [StarterKit, createIsolatedMarkdownExtensionForTests()],
    content: markdown,
    contentType: 'markdown'
  })
}

function serializeRange(editor: Editor, from: number, to: number): string {
  return serializeRichMarkdownSliceToMarkdown(
    getRichMarkdownSliceSerializer(editor),
    editor.state.doc.slice(from, to),
    editor.state.doc.resolve(from),
    to
  )
}

/** Start of the text inside the first textblock whose content matches `text`. */
function textStartOf(editor: Editor, text: string): number {
  return findNodePos(editor, (node) => node.isTextblock && node.textContent === text) + 1
}

/** Position just past the last character of the first textblock matching `text`. */
function textEndOf(editor: Editor, text: string): number {
  const pos = findNodePos(editor, (node) => node.isTextblock && node.textContent === text)
  const node = editor.state.doc.nodeAt(pos)
  if (!node) {
    throw new Error('textblock not found')
  }
  return pos + node.nodeSize - 1
}

function findNodePos(
  editor: Editor,
  predicate: (node: {
    type: { name: string }
    textContent: string
    isTextblock: boolean
  }) => boolean
): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && predicate(node)) {
      found = pos
    }
    return found === -1
  })
  if (found === -1) {
    throw new Error('node not found')
  }
  return found
}

describe('serializeRichMarkdownSliceToMarkdown', () => {
  it('serializes a whole-document selection as markdown source', () => {
    const editor = createEditor(FIXTURE)
    expect(serializeRange(editor, 0, editor.state.doc.content.size)).toBe(FIXTURE)
  })

  it('keeps inline marks and the link target for a selection inside one paragraph', () => {
    const editor = createEditor(FIXTURE)
    const paraPos = findNodePos(
      editor,
      (node) => node.type.name === 'paragraph' && node.textContent.includes('bold text')
    )
    const textStart = paraPos + 1
    const offset = editor.state.doc.resolve(textStart).parent.textContent.indexOf('bold text')
    const from = textStart + offset
    const to = from + 'bold text and `inline code`'.replace(/`/g, '').length

    expect(serializeRange(editor, from, to)).toBe('**bold text** and `inline code`')
  })

  it('omits the fence for a selection inside a code block', () => {
    const editor = createEditor(FIXTURE)
    const codePos = findNodePos(editor, (node) => node.type.name === 'codeBlock')
    const codeNode = editor.state.doc.nodeAt(codePos)
    if (!codeNode) {
      throw new Error('code block not found')
    }
    const from = codePos + 1 + 'const '.length
    const to = codePos + codeNode.nodeSize - 1

    expect(serializeRange(editor, from, to)).toBe(['answer = 42', 'console.log(answer)'].join('\n'))
  })

  it('leaves markdown characters in code content unescaped', () => {
    const editor = createEditor(
      ['```ts', 'if (a < 3) { log("x_y_z") } // **star**', '```'].join('\n')
    )
    const codePos = findNodePos(editor, (node) => node.type.name === 'codeBlock')
    const codeNode = editor.state.doc.nodeAt(codePos)
    if (!codeNode) {
      throw new Error('code block not found')
    }

    expect(serializeRange(editor, codePos + 1, codePos + codeNode.nodeSize - 1)).toBe(
      'if (a < 3) { log("x_y_z") } // **star**'
    )
  })

  it('omits the heading marker for a selection inside a heading', () => {
    const editor = createEditor(FIXTURE)
    const headingPos = findNodePos(editor, (node) => node.type.name === 'heading')

    expect(serializeRange(editor, headingPos + 2, headingPos + 1 + 'Heading On'.length)).toBe(
      'eading On'
    )
  })

  it('keeps the heading marker when the selection spans the whole heading', () => {
    const editor = createEditor(FIXTURE)
    const headingPos = findNodePos(editor, (node) => node.type.name === 'heading')
    const headingNode = editor.state.doc.nodeAt(headingPos)
    if (!headingNode) {
      throw new Error('heading not found')
    }

    expect(serializeRange(editor, headingPos, headingPos + headingNode.nodeSize)).toBe(
      '# Heading One'
    )
  })

  it('serializes an open-ended slice spanning a paragraph into a list', () => {
    const editor = createEditor(FIXTURE)
    const paraPos = findNodePos(
      editor,
      (node) => node.type.name === 'paragraph' && node.textContent.includes('bold text')
    )
    const textStart = paraPos + 1
    const from =
      textStart + editor.state.doc.resolve(textStart).parent.textContent.indexOf('bold text')
    const secondBulletPos = findNodePos(
      editor,
      (node) => node.type.name === 'paragraph' && node.textContent === 'Second bullet'
    )
    const secondBullet = editor.state.doc.nodeAt(secondBulletPos)
    if (!secondBullet) {
      throw new Error('list paragraph not found')
    }
    const to = secondBulletPos + secondBullet.nodeSize - 2

    const slice = editor.state.doc.slice(from, to)
    expect(slice.openStart).toBeGreaterThan(0)
    expect(slice.openEnd).toBeGreaterThan(0)
    expect(serializeRange(editor, from, to)).toBe(
      [
        '**bold text** and `inline code` and a [link](https://example.com/target).',
        '',
        '- First bullet',
        '- Second bulle'
      ].join('\n')
    )
  })

  it('preserves list markers and nesting across a multi-block selection', () => {
    const editor = createEditor(FIXTURE)
    const listPos = findNodePos(editor, (node) => node.type.name === 'bulletList')
    const listNode = editor.state.doc.nodeAt(listPos)
    if (!listNode) {
      throw new Error('list not found')
    }

    expect(serializeRange(editor, listPos, listPos + listNode.nodeSize)).toBe(
      ['- First bullet', '- Second bullet', '  - Nested bullet'].join('\n')
    )
  })

  it('returns undefined serializer for an editor without the markdown extension', () => {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit],
      content: '<p>plain</p>'
    })

    expect(getRichMarkdownSliceSerializer(editor)).toBeUndefined()
  })

  describe('prose with markdown-significant characters', () => {
    const PROSE =
      'Compare a < b && c, snake_case_name, 5 * 3, and "quotes" — see <https://example.com>'

    it('matches the save path for a whole-paragraph selection', () => {
      const editor = createEditor(PROSE)
      const paraPos = findNodePos(editor, (node) => node.type.name === 'paragraph')
      const paraNode = editor.state.doc.nodeAt(paraPos)
      if (!paraNode) {
        throw new Error('paragraph not found')
      }

      expect(serializeRange(editor, paraPos, paraPos + paraNode.nodeSize)).toBe(
        editor.getMarkdown()
      )
    })

    it('matches the save path for a within-paragraph selection', () => {
      const editor = createEditor(PROSE)
      const paraPos = findNodePos(editor, (node) => node.type.name === 'paragraph')
      const paraNode = editor.state.doc.nodeAt(paraPos)
      if (!paraNode) {
        throw new Error('paragraph not found')
      }
      const textStart = paraPos + 1

      expect(serializeRange(editor, textStart, textStart + paraNode.textContent.length)).toBe(
        editor.getMarkdown()
      )
    })

    it('matches the save path for a partial selection', () => {
      const editor = createEditor(PROSE)
      const paraPos = findNodePos(editor, (node) => node.type.name === 'paragraph')
      const paraNode = editor.state.doc.nodeAt(paraPos)
      if (!paraNode) {
        throw new Error('paragraph not found')
      }
      const textStart = paraPos + 1
      const selected = 'a < b && c, snake_case_name, 5 * 3'
      const from = textStart + paraNode.textContent.indexOf('a < b')

      // Save an editor containing only the selected text, so its markdown output is
      // the save path's answer for this exact substring, not a slice of the whole.
      const selectedOnlyEditor = createEditor(selected)
      expect(serializeRange(editor, from, from + selected.length)).toBe(
        selectedOnlyEditor.getMarkdown()
      )
    })
  })

  describe('selections inside one list or blockquote', () => {
    it('keeps ordered numbering for a subset starting at the first item', () => {
      const editor = createEditor('1. First item\n2. Second item\n3. Third item')

      expect(
        serializeRange(editor, textStartOf(editor, 'First item'), textEndOf(editor, 'Second item'))
      ).toBe('1. First item\n2. Second item')
    })

    it('numbers an ordered subset from the first selected item', () => {
      const editor = createEditor('1. First item\n2. Second item\n3. Third item')

      expect(
        serializeRange(editor, textStartOf(editor, 'Second item'), textEndOf(editor, 'Third item'))
      ).toBe('2. Second item\n3. Third item')
    })

    it('carries the list start attribute into an ordered subset', () => {
      const editor = createEditor('5. Fifth item\n6. Sixth item\n7. Seventh item')

      expect(
        serializeRange(editor, textStartOf(editor, 'Sixth item'), textEndOf(editor, 'Seventh item'))
      ).toBe('6. Sixth item\n7. Seventh item')
    })

    it('keeps bullet markers without blank lines for a subset of one list', () => {
      const editor = createEditor('- First item\n- Second item\n- Third item')

      expect(
        serializeRange(editor, textStartOf(editor, 'First item'), textEndOf(editor, 'Second item'))
      ).toBe('- First item\n- Second item')
    })

    it('keeps the marker for a selection starting and ending mid-item', () => {
      const editor = createEditor('1. First item\n2. Second item\n3. Third item')
      const from = textStartOf(editor, 'First item') + 'First '.length
      const to = textStartOf(editor, 'Second item') + 'Second'.length

      expect(editor.state.doc.textBetween(from, to, '|')).toBe('item|Second')
      expect(serializeRange(editor, from, to)).toBe('1. item\n2. Second')
    })

    it('keeps the inner list markers for a subset of a nested list', () => {
      const editor = createEditor('- Alpha\n  - Beta\n  - Gamma\n- Delta')

      expect(serializeRange(editor, textStartOf(editor, 'Beta'), textEndOf(editor, 'Gamma'))).toBe(
        '- Beta\n- Gamma'
      )
    })

    it('keeps the blockquote prefix for a subset of one blockquote', () => {
      const editor = createEditor('> Line one\n>\n> Line two\n>\n> Line three')

      expect(
        serializeRange(editor, textStartOf(editor, 'Line one'), textEndOf(editor, 'Line two'))
      ).toBe('> Line one\n>\n> Line two')
    })

    it('keeps one blockquote level for a subset of a nested blockquote', () => {
      const editor = createEditor('> > Inner one\n> >\n> > Inner two')

      expect(
        serializeRange(editor, textStartOf(editor, 'Inner one'), textEndOf(editor, 'Inner two'))
      ).toBe('> Inner one\n>\n> Inner two')
    })
  })

  describe('ancestors only the production extension set provides', () => {
    function createProductionEditor(markdown: string): Editor {
      return new Editor({
        element: null,
        extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
        content: markdown,
        contentType: 'markdown'
      })
    }

    function serializeProductionRange(editor: Editor, first: string, last: string): string {
      return serializeRichMarkdownSliceToMarkdown(
        getRichMarkdownSliceSerializer(editor),
        editor.state.doc.slice(textStartOf(editor, first), textEndOf(editor, last)),
        editor.state.doc.resolve(textStartOf(editor, first)),
        textEndOf(editor, last)
      )
    }

    it('keeps checkbox markers for a subset of one task list', () => {
      const editor = createProductionEditor('- [ ] Alpha\n- [x] Beta\n- [ ] Gamma')

      expect(serializeProductionRange(editor, 'Alpha', 'Beta')).toBe('- [ ] Alpha\n- [x] Beta')
    })

    it('carries the header row into a selection of table body rows', () => {
      const editor = createProductionEditor('| a | b |\n| --- | --- |\n| c1 | c2 |\n| d1 | d2 |')

      expect(serializeProductionRange(editor, 'c1', 'd2')).toBe(
        '\n| a   | b   |\n| --- | --- |\n| c1  | c2  |\n| d1  | d2  |\n'
      )
    })

    it('carries the header row into a selection of cells in one row', () => {
      const editor = createProductionEditor('| a | b |\n| --- | --- |\n| c1 | c2 |\n| d1 | d2 |')

      expect(serializeProductionRange(editor, 'c1', 'c2')).toBe(
        '\n| a   | b   |\n| --- | --- |\n| c1  | c2  |\n'
      )
    })

    it('does not repeat the header row for a selection inside it', () => {
      const editor = createProductionEditor('| a | b |\n| --- | --- |\n| c1 | c2 |\n| d1 | d2 |')

      expect(serializeProductionRange(editor, 'a', 'b')).toBe('\n| a   | b   |\n| --- | --- |\n')
    })

    it('leaves a details body selection as prose', () => {
      const editor = createProductionEditor(
        '<details><summary>Sum</summary>\n\nPara one\n\nPara two\n\n</details>'
      )

      expect(serializeProductionRange(editor, 'Para one', 'Para two')).toBe('Para one\n\nPara two')
    })
  })

  it('falls back to block-joined text when no serializer is available', () => {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit],
      content: '<p>first</p><p>second</p>'
    })
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size)

    expect(
      serializeRichMarkdownSliceToMarkdown(
        undefined,
        slice,
        editor.state.doc.resolve(1),
        editor.state.doc.content.size
      )
    ).toBe('first\n\nsecond')
  })
})

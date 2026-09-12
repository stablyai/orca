// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'
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
    editor.state.doc.resolve(from).parent
  )
}

function findNodePos(
  editor: Editor,
  predicate: (node: { type: { name: string }; textContent: string }) => boolean
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

  it('falls back to block-joined text when no serializer is available', () => {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit],
      content: '<p>first</p><p>second</p>'
    })
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size)

    expect(
      serializeRichMarkdownSliceToMarkdown(undefined, slice, editor.state.doc.resolve(1).parent)
    ).toBe('first\n\nsecond')
  })
})

import { Table } from '@tiptap/extension-table'
import { Editor, type JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function editorFor(content: string | JSONContent, upstreamTable = false): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }).map((extension) =>
      upstreamTable && extension.name === 'table'
        ? extension.extend({ renderMarkdown: Table.config.renderMarkdown })
        : extension
    ),
    content:
      typeof content === 'string' ? encodeRawMarkdownHtmlForRichEditor(content, codec) : content,
    ...(typeof content === 'string' ? { contentType: 'markdown' } : {})
  })
}

function serialize(content: string | JSONContent): string {
  const editor = editorFor(content)
  try {
    editor.state.doc.check()
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

describe('rich Markdown table serialization', () => {
  it('bounds sibling padding without truncating a long cell', () => {
    const long = 'long cell '.repeat(600).trimEnd()
    const source = `| id | notes |\n| --- | --- |\n| 1 | short |\n| 2 | ${long} |\n| 3 | short |\n| 4 | short |`
    const output = serialize(source)
    expect(output).toContain(long)
    expect(output.length).toBeLessThan(source.length + 250)
    expect(
      output.split('\n').filter((line) => line.startsWith('|') && !line.includes(long))
    ).toSatisfy((rows: string[]) => rows.every((row) => row.length < 100))
    expect(serialize(output)).toBe(output)
  })

  it('caps padding when all body cells are large', () => {
    const long = 'x'.repeat(5000)
    const output = serialize(`| a | b |\n| --- | --- |\n| ${long} | short |\n| ${long} | short |`)
    const smallRows = output
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.includes(long))
    expect(smallRows.every((row) => row.length < 150)).toBe(true)
    expect(output.match(/x{5000}/g)).toHaveLength(2)
  })

  it('preserves hard breaks and inline formatting inside table cells', () => {
    const output = serialize('| a | b |\n| --- | --- |\n| **first**<br>second | *third* |')
    expect(output).toContain('**first**<br>second')
    expect(output).toContain('*third*')
    expect(serialize(output)).toBe(output)
  })

  it('preserves separate cell blocks as breaks', () => {
    const output = serialize({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'second' }] }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
    expect(output).toContain('first<br>second')
    expect(serialize(output)).toBe(output)
  })

  it.each([
    'escaped \\| pipe',
    '`x \\| y`',
    '[x \\| y](https://example.com)',
    'backslash \\\\ before \\| pipe'
  ])('preserves the two-cell shape and text after repeated saves: %s', (cell) => {
    const source = `| a | b |\n| --- | --- |\n| ${cell} | second |`
    const before = editorFor(source)
    const after = editorFor(before.getMarkdown())
    try {
      expect(after.getJSON()).toEqual(before.getJSON())
      expect(after.getMarkdown()).toBe(before.getMarkdown())
    } finally {
      before.destroy()
      after.destroy()
    }
  })

  it.each([false, true])('preserves supported backslashes next to pipes (code: %s)', (code) => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        {
                          type: 'text',
                          text: code ? 'one \\\\| two' : 'one \\| two',
                          ...(code ? { marks: [{ type: 'code' }] } : {})
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
    const before = editorFor(content)
    const after = editorFor(before.getMarkdown())
    try {
      expect(after.state.doc.textContent).toBe(before.state.doc.textContent)
      expect(serialize(after.getMarkdown())).toBe(after.getMarkdown())
    } finally {
      before.destroy()
      after.destroy()
    }
  })

  it('retains upstream parsing for an odd code backslash without splitting the cell', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        {
                          type: 'text',
                          text: 'one \\| two',
                          marks: [{ type: 'code' }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
    const before = editorFor(content)
    const upstream = editorFor(content, true)
    const currentParse = editorFor(before.getMarkdown())
    const upstreamParse = editorFor(upstream.getMarkdown())
    try {
      // Marked removes the odd code slash; retain that existing limitation without a new parser.
      expect(currentParse.getJSON()).toEqual(upstreamParse.getJSON())
      expect(currentParse.state.doc.textContent).toBe('one | two')
      expect(serialize(before.getMarkdown())).toBe(before.getMarkdown())
    } finally {
      before.destroy()
      upstream.destroy()
      currentParse.destroy()
      upstreamParse.destroy()
    }
  })

  it('keeps all three column alignments on a reparse', () => {
    const editor = editorFor(
      '| left | middle | right |\n| :--- | :---: | ---: |\n| one | two | three |'
    )
    const reparsed = editorFor(editor.getMarkdown())
    try {
      expect(reparsed.getJSON()).toEqual(editor.getJSON())
    } finally {
      editor.destroy()
      reparsed.destroy()
    }
  })
})

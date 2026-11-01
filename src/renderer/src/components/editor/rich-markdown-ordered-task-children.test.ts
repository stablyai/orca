// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { normalizeEmptyListItems } from './rich-markdown-normalize'
import { registerRichMarkdownBlockSource } from './rich-markdown-block-source'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

function openMarkdown(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  normalizeEmptyListItems(editor)
  registerRichMarkdownBlockSource(editor, codec, false)
  return editor
}

function taskItems(editor: Editor) {
  const tasks: { text: string; checked: boolean; depth: number }[] = []
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'taskItem') {
      tasks.push({
        text: node.firstChild?.textContent ?? '',
        checked: node.attrs.checked === true,
        depth: editor.state.doc.resolve(position).depth
      })
    }
  })
  return tasks
}

function roundTrip(source: string): string {
  const editor = openMarkdown(source)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

const expectedTasks = [
  { text: 'First', checked: false, depth: 3 },
  { text: 'Middle', checked: true, depth: 3 },
  { text: 'Last', checked: true, depth: 3 }
]

describe('task children of ordered list items', () => {
  it.each([
    ['4. Parent', 3, '-'],
    ['10) Parent', 4, '-']
  ] as const)('keeps sibling task states under %s at indent %s', (parent, indent, marker) => {
    const source = [
      parent,
      `${' '.repeat(indent)}${marker} [ ] First`,
      `${' '.repeat(indent)}${marker} [x] Middle`,
      `${' '.repeat(indent)}${marker} [X] Last`
    ].join('\n')
    const editor = openMarkdown(source)
    try {
      editor.state.doc.check()
      expect(taskItems(editor)).toEqual(expectedTasks)
    } finally {
      editor.destroy()
    }
  })

  it('preserves checked siblings when Enter splits a task before save and reopen', () => {
    const source = '4. Parent\n   - [ ] First\n   - [x] Middle\n   - [x] Last'
    const editor = openMarkdown(source)
    try {
      const refs = {
        originalSourceRef: { current: source },
        baseCanonicalRef: { current: editor.getMarkdown() },
        lastCommittedMarkdownRef: { current: source }
      }
      let end = -1
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === 'taskItem' && node.firstChild?.textContent === 'First') {
          end = position + 2 + node.firstChild.content.size
        }
      })
      expect(end).toBeGreaterThan(0)
      editor.commands.setTextSelection(end)
      expect(editor.commands.splitListItem('taskItem')).toBe(true)
      const saved = commitRichMarkdownSerialization(editor, refs, roundTrip)
      expect(saved.didSerialize).toBe(true)
      const reopened = openMarkdown(saved.markdown)
      try {
        reopened.state.doc.check()
        expect(taskItems(reopened).filter((task) => task.text !== '')).toEqual(expectedTasks)
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it.each([
    ['1. Parent\n   - [ ] a\n    - [x] b', 3],
    ['10. Parent\n    - [ ] a\n     - [x] b', 3],
    ['> 1. Parent\n>    - [ ] a\n>     - [x] b', 4]
  ] as const)('keeps a task one column deeper as a sibling checkbox in %j', (source, depth) => {
    const editor = openMarkdown(source)
    try {
      editor.state.doc.check()
      expect(taskItems(editor)).toEqual([
        { text: 'a', checked: false, depth },
        { text: 'b', checked: true, depth }
      ])
    } finally {
      editor.destroy()
    }
  })

  it('keeps a four-space continuation paragraph free of leftover indent', () => {
    const editor = openMarkdown('1. Parent\n    - [ ] a\n        more text')
    try {
      const paragraphs: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'paragraph') {
          paragraphs.push(node.textContent)
        }
      })
      expect(paragraphs).toEqual(['Parent', 'a', 'more text'])
    } finally {
      editor.destroy()
    }
  })

  it('keeps an intentionally nested task under its owning sibling', () => {
    const editor = openMarkdown(
      '4. Parent\n   - [ ] First\n     - [x] Child\n   - [x] Middle\n   - [x] Last'
    )
    try {
      expect(taskItems(editor)).toEqual([
        expectedTasks[0],
        { text: 'Child', checked: true, depth: 5 },
        expectedTasks[1],
        expectedTasks[2]
      ])
    } finally {
      editor.destroy()
    }
  })

  it('keeps following plain bullets and the next ordered item in their own lists', () => {
    const editor = openMarkdown(
      '4. Parent\n   - [ ] First\n   - Plain\n   - [x] Last\n5. Following'
    )
    try {
      editor.state.doc.check()
      expect(taskItems(editor)).toEqual([expectedTasks[0], expectedTasks[2]])
      expect(editor.state.doc.firstChild?.childCount).toBe(2)
      expect(editor.state.doc.firstChild?.lastChild?.textContent).toBe('Following')
      const plainItems: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'listItem' && node.firstChild?.textContent === 'Plain') {
          plainItems.push(node.type.name)
        }
      })
      expect(plainItems).toEqual(['listItem'])
    } finally {
      editor.destroy()
    }
  })
})

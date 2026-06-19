import { describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  exitEmptyDetailsBody,
  moveFromEmptyDetailsBodyToSummary
} from './rich-markdown-details-extension'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'

function createEditor(content: string | JSONContent) {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions(),
    content,
    contentType: 'markdown'
  })
}

function firstDetailsBodyCursorPosition(editor: Editor): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.content.size === 0) {
      const parent = editor.state.doc.resolve(pos).parent
      if (parent.type.name === 'detailsContent') {
        position = pos + 1
        return false
      }
    }

    return true
  })

  if (position === null) {
    throw new Error('Expected an empty details body paragraph')
  }

  return position
}

function firstTextEndPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      position = pos + text.length
      return false
    }

    return true
  })

  if (position === null) {
    throw new Error(`Expected text: ${text}`)
  }

  return position
}

function selectionHasAncestor(editor: Editor, typeName: string): boolean {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    if ($from.node(depth).type.name === typeName) {
      return true
    }
  }

  return false
}

function firstDetailsContent(editor: Editor): ProseMirrorNode {
  let content: ProseMirrorNode | null = null
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'detailsContent') {
      content = node
      return false
    }

    return true
  })

  if (!content) {
    throw new Error('Expected details content')
  }

  return content
}

describe('rich markdown details keyboard behavior', () => {
  it.each([
    [
      'text toggle',
      '<details><summary>Toggle</summary><p></p></details>',
      '<details class="orca-details">\n<summary>Toggle</summary>\n\n\n\n</details>'
    ],
    [
      'heading toggle',
      '<details data-orca-toggle="heading-1"><summary>Toggle</summary><p></p></details>',
      '<details class="orca-details" data-orca-toggle="heading-1">\n<summary>Toggle</summary>\n\n\n\n</details>'
    ]
  ])('moves backspace from an empty %s body to the summary', (_name, content, expected) => {
    const editor = createEditor(content)

    try {
      editor.commands.setTextSelection(firstDetailsBodyCursorPosition(editor))

      expect(moveFromEmptyDetailsBodyToSummary(editor)).toBe(true)
      expect(editor.getMarkdown().trimEnd()).toBe(expected)
      expect(editor.state.selection.$from.parent.type.name).toBe('detailsSummary')
      expect(editor.state.selection.$from.parentOffset).toBe('Toggle'.length)
    } finally {
      editor.destroy()
    }
  })

  it('does not hijack backspace when an empty first toggle body line has content after it', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open: true, variant: null },
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'Toggle' }] },
            {
              type: 'detailsContent',
              content: [
                { type: 'paragraph' },
                { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }
              ]
            }
          ]
        }
      ]
    })

    try {
      editor.commands.setTextSelection(firstDetailsBodyCursorPosition(editor))

      expect(moveFromEmptyDetailsBodyToSummary(editor)).toBe(false)
      expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
    } finally {
      editor.destroy()
    }
  })

  it.each([
    ['text toggle', '<details><summary>Toggle</summary><p></p></details>'],
    [
      'heading toggle',
      '<details data-orca-toggle="heading-1"><summary>Toggle</summary><p></p></details>'
    ]
  ])('exits an empty %s body on Enter', (_name, content) => {
    const editor = createEditor(content)

    try {
      editor.commands.setTextSelection(firstDetailsBodyCursorPosition(editor))

      expect(exitEmptyDetailsBody(editor)).toBe(true)
      expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
      expect(selectionHasAncestor(editor, 'detailsContent')).toBe(false)
      expect(firstDetailsContent(editor).childCount).toBe(1)
    } finally {
      editor.destroy()
    }
  })

  it('creates another paragraph inside a non-empty toggle body on Enter', () => {
    const editor = createEditor('<details><summary>Toggle</summary><p>Body</p></details>')

    try {
      editor.commands.setTextSelection(firstTextEndPosition(editor, 'Body'))

      expect(exitEmptyDetailsBody(editor)).toBe(false)
      expect(editor.commands.splitBlock()).toBe(true)
      expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
      expect(selectionHasAncestor(editor, 'detailsContent')).toBe(true)
      expect(firstDetailsContent(editor).childCount).toBe(2)
    } finally {
      editor.destroy()
    }
  })

  it('inserts a soft break inside a toggle body on Shift+Enter', () => {
    const editor = createEditor('<details><summary>Toggle</summary><p>Body</p></details>')

    try {
      editor.commands.setTextSelection(firstTextEndPosition(editor, 'Body'))

      expect(editor.commands.setHardBreak()).toBe(true)
      expect(selectionHasAncestor(editor, 'detailsContent')).toBe(true)
      expect(firstDetailsContent(editor).firstChild?.firstChild?.type.name).toBe('text')
      expect(firstDetailsContent(editor).firstChild?.child(1).type.name).toBe('hardBreak')
    } finally {
      editor.destroy()
    }
  })
})

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { buildRichMarkdownCommentBlocks } from './rich-markdown-review-annotations'
import { getRichMarkdownReviewRailBlocks } from './rich-markdown-review-rail-blocks'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'

const editors: Editor[] = []

function createEditor(
  content: string | JSONContent = '# Heading\n\nFirst paragraph\n\n- One\n- Two'
) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    ...(typeof content === 'string' ? { contentType: 'markdown' as const } : {})
  })
  editors.push(editor)
  // Settle the trailing-node plugin before measuring selection-only transactions.
  editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  vi.restoreAllMocks()
})

describe('review rail source block reuse', () => {
  it.each([
    '```ts\nconst value = 1\n\nvalue++\n```\n\nAfter code',
    '| First | Second |\n| --- | --- |\n| one | two |\n\nAfter table',
    '<details><summary>Toggle</summary>\n\nInside\n\n</details>\n\nAfter toggle'
  ])('preserves multiline block boundaries for %s', (source) => {
    const editor = createEditor(source)
    expect(getRichMarkdownReviewRailBlocks(editor)).toEqual(buildRichMarkdownCommentBlocks(editor))
  })

  it('preserves block lines and reuses them after selection-only transactions', () => {
    const editor = createEditor()
    const expected = buildRichMarkdownCommentBlocks(editor)
    const serialize = vi.spyOn(editor.markdown!, 'serialize')
    const blocks = getRichMarkdownReviewRailBlocks(editor)
    expect(blocks).toEqual(expected)
    expect(serialize).toHaveBeenCalledTimes(2 * editor.state.doc.childCount - 1)
    serialize.mockClear()
    editor.commands.setTextSelection(3)
    expect(getRichMarkdownReviewRailBlocks(editor)).toBe(blocks)
    expect(serialize).not.toHaveBeenCalled()
  })

  it('rebuilds after edits and undo while keeping editors isolated', () => {
    const editor = createEditor()
    const original = getRichMarkdownReviewRailBlocks(editor)
    editor.commands.insertContentAt(1, 'changed\ntext')
    const changed = getRichMarkdownReviewRailBlocks(editor)
    expect(changed).not.toBe(original)
    expect(changed).toEqual(buildRichMarkdownCommentBlocks(editor))
    editor.commands.undo()
    expect(getRichMarkdownReviewRailBlocks(editor)).toEqual(original)
    expect(getRichMarkdownReviewRailBlocks(createEditor())).not.toBe(original)
  })

  it('invalidates an in-place serializer replacement and a manager replacement', () => {
    const editor = createEditor()
    const original = getRichMarkdownReviewRailBlocks(editor)
    const serialize = editor.markdown!.serialize.bind(editor.markdown)
    vi.spyOn(editor.markdown!, 'serialize').mockImplementation(
      (content) => `${serialize(content)}\nextra line`
    )
    const changed = getRichMarkdownReviewRailBlocks(editor)
    expect(changed).not.toEqual(original)
    expect(changed).toEqual(buildRichMarkdownCommentBlocks(editor))
    editor.markdown = createEditor().markdown
    expect(getRichMarkdownReviewRailBlocks(editor)).toEqual(original)
  })

  it('does not reuse fallback lines after a missing serializer becomes available', () => {
    const editor = createEditor()
    const markdown = editor.markdown
    editor.markdown = undefined
    const fallback = getRichMarkdownReviewRailBlocks(editor)
    expect(fallback).toEqual(buildRichMarkdownCommentBlocks(editor))
    editor.markdown = markdown
    expect(getRichMarkdownReviewRailBlocks(editor)).not.toEqual(fallback)
    expect(getRichMarkdownReviewRailBlocks(editor)).toEqual(buildRichMarkdownCommentBlocks(editor))
  })

  it('avoids serialization for every comment and repeated scroll while refreshing geometry', () => {
    const editor = createEditor()
    let sourceTop = 100
    const coords = vi.spyOn(editor.view, 'coordsAtPos').mockImplementation(() => ({
      top: sourceTop,
      bottom: sourceTop + 20,
      left: 0,
      right: 10
    }))
    const container = document.createElement('div')
    const comment: DiffComment = {
      id: 'note',
      worktreeId: 'workspace',
      filePath: 'notes.md',
      source: 'markdown',
      lineNumber: 1,
      body: 'Review',
      createdAt: 1,
      side: 'modified'
    }
    const markdownComments = Array.from({ length: 5 }, (_, index) => ({
      ...comment,
      id: `note-${index}`,
      selectedText: index === 0 ? 'Heading' : undefined
    }))
    const serialize = vi.spyOn(editor.markdown!, 'serialize')
    const measure = () =>
      measureRichMarkdownReviewNotePositions({
        editor,
        container,
        markdownComments,
        markdownSourceLineOffset: 0
      })
    expect(measure()[0]?.top).toBe(100)
    expect(serialize).toHaveBeenCalledTimes(2 * editor.state.doc.childCount - 1)
    serialize.mockClear()
    sourceTop = 200
    container.scrollTop = 30
    for (let index = 0; index < 60; index++) {
      expect(measure()[0]?.top).toBe(230)
    }
    expect(serialize).not.toHaveBeenCalled()
    expect(coords).toHaveBeenCalledTimes(61 * markdownComments.length)
  })
})

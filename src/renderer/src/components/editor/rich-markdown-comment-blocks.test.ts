// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  buildRichMarkdownCommentBlocks,
  getRichMarkdownCommentBlocks
} from './rich-markdown-comment-blocks'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import {
  createRichMarkdownHtmlSuperscriptLinkContext,
  type RichMarkdownHtmlSuperscriptLinkContext
} from './rich-markdown-html-superscript-link-context'
import {
  getRichMarkdownAnnotationHighlightRanges,
  getRichMarkdownAnnotationHighlightRangesForComment,
  getRichMarkdownAnnotationTarget,
  getRichMarkdownCommentAtPos
} from './rich-markdown-review-annotations'
import { getRichMarkdownReviewRailBlocks } from './rich-markdown-review-rail-blocks'

const editors: Editor[] = []
const SOURCE = 'First paragraph\n\n```ts\none\n\ntwo\n```\n\nLast paragraph'

function createEditor(source = SOURCE, context?: RichMarkdownHtmlSuperscriptLinkContext) {
  const root = document.createElement('div')
  document.body.append(root)
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: root,
    extensions: createRichMarkdownExtensions({
      codec,
      htmlSuperscriptLinks: Boolean(context),
      htmlSuperscriptLinkContext: context
    }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec, {
      htmlSuperscriptLinks: Boolean(context)
    }),
    contentType: 'markdown'
  })
  editors.push(editor)
  editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 400))
  return { editor, root }
}

function selectLastParagraph(editor: Editor, characters = 4) {
  let from: number | undefined
  editor.state.doc.forEach((node, offset) => {
    if (node.textContent === 'Last paragraph') {
      from = offset + 1
    }
  })
  if (from === undefined) {
    throw new Error('Last paragraph missing')
  }
  editor.commands.setTextSelection({ from, to: from + characters })
  const paragraph = Array.from(editor.view.dom.querySelectorAll('p')).find(
    (element) => element.textContent === 'Last paragraph'
  )
  const text = paragraph?.firstChild
  if (!(text instanceof Text)) {
    throw new Error('Last paragraph text missing')
  }
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, characters)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  return from
}

function comment(lineNumber = 29): DiffComment {
  return {
    id: 'note',
    worktreeId: 'workspace',
    filePath: 'notes.md',
    source: 'markdown',
    lineNumber,
    selectedText: 'Last',
    body: 'Review',
    createdAt: 1,
    side: 'modified'
  }
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('Markdown review source block reuse', () => {
  it('preserves source lines when the document interaction host changes', () => {
    const context = createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '/repo/notes.md',
      worktreeId: 'workspace',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' }
    })
    const { editor } = createEditor(
      'First <sup><a href="./source.md">[1]</a></sup>\n\nLast paragraph',
      context
    )
    const blocks = getRichMarkdownCommentBlocks(editor)
    const doc = editor.state.doc
    const serialize = vi.spyOn(editor.markdown!, 'serialize')
    const instrumentedBlocks = getRichMarkdownCommentBlocks(editor)
    serialize.mockClear()
    context.update({
      sourceFilePath: '/remote/notes.md',
      worktreeId: 'remote-workspace',
      worktreeRoot: '/remote',
      sourceOwner: { kind: 'ssh', connectionId: 'connection' }
    })
    expect(editor.state.doc).toBe(doc)
    expect(getRichMarkdownCommentBlocks(editor)).toBe(instrumentedBlocks)
    expect(serialize).not.toHaveBeenCalled()
    serialize.mockRestore()
    expect(buildRichMarkdownCommentBlocks(editor)).toEqual(blocks)
  })

  it('shares one source map across highlights, comment clicks, selection targets and the rail', () => {
    const { editor, root } = createEditor()
    const from = selectLastParagraph(editor)
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 80, 20))
    const serialize = vi.spyOn(editor.markdown!, 'serialize')
    const json = vi.spyOn(editor, 'getJSON')
    const note = comment()
    const expected = [{ from, to: from + 4 }]

    expect(getRichMarkdownAnnotationHighlightRanges(editor, [note], 20)).toEqual(expected)
    expect(serialize).toHaveBeenCalledTimes(2 * editor.state.doc.childCount - 1)
    expect(json).toHaveBeenCalledTimes(1)
    serialize.mockClear()
    json.mockClear()

    for (let index = 0; index < 20; index++) {
      expect(getRichMarkdownAnnotationHighlightRanges(editor, [note], 20)).toEqual(expected)
      expect(getRichMarkdownAnnotationHighlightRangesForComment(editor, note, 20)).toEqual(expected)
      expect(getRichMarkdownCommentAtPos(editor, [note], 20, from + 2)).toBe(note)
      expect(getRichMarkdownAnnotationTarget(editor, root)).toMatchObject({
        from,
        to: from + 4,
        selectedText: 'Last',
        lineNumber: 9
      })
      expect(getRichMarkdownReviewRailBlocks(editor)).toBe(getRichMarkdownCommentBlocks(editor))
    }
    expect(serialize).not.toHaveBeenCalled()
    expect(json).not.toHaveBeenCalled()
  })

  it('updates selected text and viewport geometry without rebuilding source lines', () => {
    const { editor, root } = createEditor()
    const rect = vi.spyOn(Range.prototype, 'getBoundingClientRect')
    rect.mockReturnValue(new DOMRect(10, 20, 80, 20))
    selectLastParagraph(editor)
    const serialize = vi.spyOn(editor.markdown!, 'serialize')
    expect(getRichMarkdownAnnotationTarget(editor, root)).toMatchObject({
      selectedText: 'Last',
      buttonTop: 48,
      lineNumber: 9
    })
    serialize.mockClear()
    const doc = editor.state.doc
    selectLastParagraph(editor, 9)
    rect.mockReturnValue(new DOMRect(10, 120, 140, 20))
    expect(getRichMarkdownAnnotationTarget(editor, root)).toMatchObject({
      selectedText: 'Last para',
      buttonTop: 148,
      lineNumber: 9
    })
    expect(editor.state.doc).toBe(doc)
    expect(serialize).not.toHaveBeenCalled()
  })

  it('rebuilds source lines after editing a multiline block and undoing it', () => {
    const { editor, root } = createEditor()
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 80, 20))
    selectLastParagraph(editor)
    expect(getRichMarkdownAnnotationTarget(editor, root)?.lineNumber).toBe(9)
    const serialize = vi.spyOn(editor.markdown!, 'serialize')
    let codeFrom: number | undefined
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'codeBlock') {
        codeFrom = offset + 1
      }
    })
    if (codeFrom === undefined) {
      throw new Error('Code block missing')
    }
    editor.view.dispatch(editor.state.tr.insertText('new\n', codeFrom))
    selectLastParagraph(editor)
    expect(getRichMarkdownAnnotationTarget(editor, root)?.lineNumber).toBe(10)
    expect(serialize).toHaveBeenCalledTimes(2 * editor.state.doc.childCount - 1)
    expect(
      getRichMarkdownCommentAtPos(editor, [comment(30)], 20, editor.state.selection.from)
    ).toEqual(comment(30))
    expect(serialize).toHaveBeenCalledTimes(2 * editor.state.doc.childCount - 1)
    serialize.mockClear()

    expect(editor.commands.undo()).toBe(true)
    selectLastParagraph(editor)
    expect(getRichMarkdownAnnotationTarget(editor, root)?.lineNumber).toBe(9)
    expect(serialize).toHaveBeenCalledTimes(2 * editor.state.doc.childCount - 1)
    serialize.mockClear()
    expect(getRichMarkdownAnnotationTarget(editor, root)?.lineNumber).toBe(9)
    expect(serialize).not.toHaveBeenCalled()
  })
})

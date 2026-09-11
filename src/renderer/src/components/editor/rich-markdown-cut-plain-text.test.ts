// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'
import {
  getRichMarkdownSliceSerializer,
  serializeRichMarkdownSliceToMarkdown
} from './rich-markdown-clipboard-markdown-text'
import { handleRichMarkdownCut } from './rich-markdown-cut-handler'
import { cutVisualLine } from './rich-markdown-visual-line'

vi.mock('./rich-markdown-source-owning-cut-feedback', () => ({
  showRichMarkdownSourceOwningCutLimitError: vi.fn()
}))

const FIXTURE = ['# Heading One', '', '- First bullet', '- Second bullet'].join('\n')

/**
 * Mirrors the production wiring: `clipboardTextSerializer` closes over the
 * editor, which is how the cut paths reach the markdown manager through
 * `view.someProp`.
 */
function createEditor(markdown: string): Editor {
  let editor: Editor | null = null
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, createIsolatedMarkdownExtensionForTests()],
    content: markdown,
    contentType: 'markdown',
    editorProps: {
      clipboardTextSerializer: (slice, view) =>
        serializeRichMarkdownSliceToMarkdown(
          getRichMarkdownSliceSerializer(editor),
          slice,
          view.state.selection.$from.parent
        )
    }
  })
  return editor
}

/** Minimal DataTransfer recording both flavors. */
function createClipboardData(): DataTransfer {
  const store = new Map<string, string>()
  return {
    setData: (format: string, value: string) => store.set(format, value),
    getData: (format: string) => store.get(format) ?? ''
  } as unknown as DataTransfer
}

function createCutEvent(clipboardData: DataTransfer): ClipboardEvent {
  return Object.assign(new Event('cut'), { clipboardData }) as unknown as ClipboardEvent
}

function findParagraphPos(editor: Editor, text: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === 'paragraph' && node.textContent === text) {
      found = pos
    }
    return found === -1
  })
  if (found === -1) {
    throw new Error(`paragraph not found: ${text}`)
  }
  return found
}

function cutAt(editor: Editor, pos: number): DataTransfer {
  const clipboardData = createClipboardData()
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos, pos))
  )
  handleRichMarkdownCut(editor.view, createCutEvent(clipboardData))
  return clipboardData
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cut paths write markdown to the plain-text flavor', () => {
  it('cuts a heading as markdown source, not bare text', () => {
    const editor = createEditor(FIXTURE)

    expect(cutAt(editor, 3).getData('text/plain')).toBe('# Heading One')
  })

  it('cuts a list item keeping its bullet marker', () => {
    const editor = createEditor(FIXTURE)
    const bulletPos = findParagraphPos(editor, 'First bullet')

    expect(cutAt(editor, bulletPos + 2).getData('text/plain')).toBe('- First bullet')
  })

  it('keeps the html flavor alongside the markdown plain-text flavor', () => {
    const editor = createEditor(FIXTURE)

    const clipboardData = cutAt(editor, 3)

    expect(clipboardData.getData('text/html')).toContain('<h1')
    expect(clipboardData.getData('text/plain')).toBe('# Heading One')
  })

  it('cuts a visual line through the same serializer', () => {
    const editor = createEditor('A paragraph with **bold text** inside.')
    const clipboardData = createClipboardData()
    const paragraphEnd = editor.state.doc.content.size - 1

    cutVisualLine(editor.view, createCutEvent(clipboardData), { from: 1, to: paragraphEnd })

    expect(clipboardData.getData('text/plain')).toBe('A paragraph with **bold text** inside.')
  })

  it('falls back to visible text on a view without a serializer', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, createIsolatedMarkdownExtensionForTests()],
      content: '# Heading One',
      contentType: 'markdown'
    })

    const clipboardData = createClipboardData()
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3, 3)))
    handleRichMarkdownCut(editor.view, createCutEvent(clipboardData))

    expect(clipboardData.getData('text/plain')).toBe('Heading One')
  })
})

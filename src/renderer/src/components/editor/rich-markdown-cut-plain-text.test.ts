// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'
import { serializeRichMarkdownSliceToMarkdown } from './rich-markdown-clipboard-markdown-text'
import { handleRichMarkdownCut } from './rich-markdown-cut-handler'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import { RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT } from './rich-markdown-source-owning-slice'
import { cutVisualLine } from './rich-markdown-visual-line'

const cutError = vi.hoisted(() => vi.fn())
vi.mock('./rich-markdown-source-owning-cut-feedback', () => ({
  showRichMarkdownSourceOwningCutLimitError: cutError
}))

const FIXTURE = ['# Heading One', '', '- First bullet', '- Second bullet'].join('\n')
const editors: Editor[] = []

function createEditor(markdown: string, sourceOwning = false): Editor {
  let editor: Editor | null = null
  editor = new Editor({
    element: document.createElement('div'),
    extensions: sourceOwning
      ? createRichMarkdownExtensions({
          codec: createRichMarkdownEditorCodec(),
          htmlSuperscriptLinks: true,
          htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
            sourceFilePath: '/fixture/source.md',
            worktreeId: 'fixture',
            worktreeRoot: '/fixture',
            sourceOwner: { kind: 'local' }
          })
        })
      : [StarterKit, createIsolatedMarkdownExtensionForTests()],
    content: markdown,
    contentType: 'markdown',
    editorProps: {
      clipboardTextSerializer: (slice, view) =>
        serializeRichMarkdownSliceToMarkdown(editor, slice, view.state.selection.$from)
    }
  })
  editors.push(editor)
  return editor
}

function createClipboardData(): DataTransfer {
  return new DataTransfer()
}

function createCutEvent(clipboardData: DataTransfer): ClipboardEvent {
  return new ClipboardEvent('cut', { clipboardData, cancelable: true })
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
  editors.splice(0).forEach((editor) => editor.destroy())
  cutError.mockReset()
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

  it('cuts a later ordered item with its original number', () => {
    const editor = createEditor('7. First\n8. Second\n9. Third')
    const pos = findParagraphPos(editor, 'Second')
    expect(cutAt(editor, pos + 2).getData('text/plain')).toBe('8. Second')
    expect(editor.state.doc.textContent).not.toContain('Second')
  })

  it('cuts a nested ordered item when its caret is far beyond the range start', () => {
    const editor = createEditor(
      '1. Outer\n   7. First nested\n   8. Second nested\n   9. Third nested'
    )
    const pos = findParagraphPos(editor, 'Second nested')
    const copied = cutAt(editor, pos + 10).getData('text/plain')
    expect(copied).toBe('8. Second nested')
    expect(copied).not.toContain('First nested')
    expect(copied).not.toContain('Third nested')
    expect(editor.state.doc.textContent).toContain('Outer')
    expect(editor.state.doc.textContent).not.toContain('Second nested')
  })

  it('uses the supplied visual-line range rather than the caret position', () => {
    const editor = createEditor('Alpha **bold** omega.')
    editor.commands.setTextSelection(15)
    const clipboardData = createClipboardData()
    cutVisualLine(editor.view, createCutEvent(clipboardData), { from: 7, to: 11 })
    expect(clipboardData.getData('text/plain')).toBe('**bold**')
    expect(editor.state.doc.textContent).toBe('Alpha  omega.')
  })

  it('keeps a source-owning atom in both flavors when a cut succeeds', () => {
    const editor = createEditor('', true)
    const source = '<sup><a href="https://example.com/fixture">[12]</a></sup>'
    const atom = editor.schema.nodes.richMarkdownHtmlSuperscriptLink.create({
      source,
      href: 'https://example.com/fixture',
      label: '[12]',
      title: null
    })
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [atom.toJSON()] }]
    })
    const clipboardData = cutAt(editor, 1)
    expect(clipboardData.getData('text/plain')).toBe(source)
    expect(clipboardData.getData('text/html')).toContain('data-orca-superscript-link-source')
    expect(editor.state.doc.textContent).toBe('')
  })

  it('retains the document and selection when the clipboard rejects the new plain flavor', () => {
    class RejectingClipboard extends DataTransfer {
      override getData(format: string): string {
        return format === 'text/plain' ? '' : super.getData(format)
      }
    }
    const editor = createEditor('7. First\n8. Second')
    const pos = findParagraphPos(editor, 'Second') + 4
    editor.commands.setTextSelection(pos)
    const original = editor.state.doc
    handleRichMarkdownCut(editor.view, createCutEvent(new RejectingClipboard()))
    expect(cutError).toHaveBeenCalledOnce()
    expect(editor.state.doc).toBe(original)
    expect(editor.state.selection.from).toBe(pos)
  })

  it('rejects an oversized source-owning cut before serialization or deletion', () => {
    const editor = createEditor('', true)
    const atom = editor.schema.nodes.richMarkdownHtmlSuperscriptLink.create({
      source: '<sup><a href="x">[1]</a></sup>',
      href: 'x',
      label: '[1]',
      title: null
    })
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            editor.schema.text('a'.repeat(RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT)).toJSON(),
            atom.toJSON()
          ]
        }
      ]
    })
    editor.commands.setTextSelection(2)
    const original = editor.state.doc
    const serialize = vi.spyOn(editor.view, 'serializeForClipboard')
    handleRichMarkdownCut(editor.view, createCutEvent(createClipboardData()))
    expect(cutError).toHaveBeenCalledOnce()
    expect(serialize).not.toHaveBeenCalled()
    expect(editor.state.doc).toBe(original)
    expect(editor.state.selection.from).toBe(2)
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

    editors.push(editor)
    const clipboardData = createClipboardData()
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3, 3)))
    handleRichMarkdownCut(editor.view, createCutEvent(clipboardData))

    expect(clipboardData.getData('text/plain')).toBe('Heading One')
  })
})

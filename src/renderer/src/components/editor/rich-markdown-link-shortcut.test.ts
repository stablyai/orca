// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownLinkShortcut } from './rich-markdown-link-shortcut'

const TEST_KEY = '0123456789abcdef0123456789abcdef'

function createEditor(content: string): {
  editor: Editor
  context: ReturnType<typeof createRichMarkdownHtmlSuperscriptLinkContext>
  root: HTMLDivElement
} {
  const codec = createRichMarkdownEditorCodec(TEST_KEY)
  const context = createRichMarkdownHtmlSuperscriptLinkContext({
    sourceFilePath: '/repo/README.md',
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo',
    sourceOwner: { kind: 'local' }
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  const editor = new Editor({
    element: root,
    extensions: createRichMarkdownExtensions({
      codec,
      htmlSuperscriptLinks: true,
      htmlSuperscriptLinkContext: context
    }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec, {
      htmlSuperscriptLinks: true
    }),
    contentType: 'markdown'
  })
  return { editor, context, root }
}

function keyEvent(): KeyboardEvent {
  return {
    key: 'k',
    metaKey: true,
    ctrlKey: false,
    preventDefault: vi.fn()
  } as unknown as KeyboardEvent
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('handleRichMarkdownLinkShortcut', () => {
  it('opens the html-superscript action bubble for a citation NodeSelection', () => {
    const source = '<sup><a href="https://example.com">1</a></sup>'
    const { editor, context, root } = createEditor(`See note ${source}.`)
    try {
      let citationPos = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'richMarkdownHtmlSuperscriptLink' && citationPos < 0) {
          citationPos = pos
        }
      })
      expect(citationPos).toBeGreaterThanOrEqual(0)
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, citationPos))
      )

      const setLinkBubble = vi.fn()
      const setEditing = vi.fn()

      const handled = handleRichMarkdownLinkShortcut({
        editor,
        event: keyEvent(),
        htmlSuperscriptLinkContext: context,
        isEditing: false,
        isMac: true,
        root,
        setEditing,
        setLinkBubble
      })

      expect(handled).toBe(true)
      expect(setEditing).toHaveBeenCalledWith(false)
      expect(setLinkBubble).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'html-superscript',
          href: 'https://example.com',
          label: '1'
        })
      )
    } finally {
      editor.destroy()
      root.remove()
    }
  })

  it('opens an editable markdown bubble when there is no link selection', () => {
    const { editor, context, root } = createEditor('plain text')
    try {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
      const setLinkBubble = vi.fn()
      const setEditing = vi.fn()

      handleRichMarkdownLinkShortcut({
        editor,
        event: keyEvent(),
        htmlSuperscriptLinkContext: context,
        isEditing: false,
        isMac: true,
        root,
        setEditing,
        setLinkBubble
      })

      expect(setEditing).toHaveBeenCalledWith(true)
      expect(setLinkBubble).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'markdown',
          href: ''
        })
      )
    } finally {
      editor.destroy()
      root.remove()
    }
  })
})

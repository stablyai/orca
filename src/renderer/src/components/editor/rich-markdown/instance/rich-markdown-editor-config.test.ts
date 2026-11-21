// @vitest-environment happy-dom

import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { Editor } from '@tiptap/react'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import type { DocLinkMenuState } from '../doc-links/rich-markdown-commands'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMParser as DocumentParser } from '@tiptap/pm/model'
import type { LinkBubbleState } from '../links/RichMarkdownLinkBubble'
import {
  createRichMarkdownEditorConfig,
  type EditorConfigParams
} from './rich-markdown-editor-config'
import type { SlashMenuState } from '../commands/rich-markdown-slash-command-primitives'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'

vi.mock('../links/rich-markdown-editor-click-routing', () => ({
  handleRichMarkdownEditorClick: vi.fn(() => false)
}))

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function stateSetter<T>(): Dispatch<SetStateAction<T>> {
  return vi.fn() as Dispatch<SetStateAction<T>>
}

function createConfigParams(overrides: Partial<EditorConfigParams> = {}): EditorConfigParams {
  const codec = createRichMarkdownEditorCodec()
  return {
    codec,
    htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '/repo/README.md',
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' }
    }),
    content: '',
    filePath: '/repo/README.md',
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo',
    runtimeEnvironmentId: null,
    isMac: false,
    richMarkdownSpellcheckEnabled: true,
    runtimeTarget: { kind: 'local' },
    activateMarkdownLink: vi.fn(),
    rootRef: ref<HTMLDivElement | null>(null),
    editorRef: ref<Editor | null>(null),
    lastCommittedMarkdownRef: ref(''),
    originalSourceRef: ref(''),
    baseCanonicalRef: ref(''),
    reconcileRoundTripRef: ref<(markdown: string) => string | null>(() => null),
    onContentChangeRef: ref(vi.fn()),
    onDirtyStateHintRef: ref(vi.fn()),
    onSaveRef: ref(vi.fn()),
    onOpenDocLinkRef: ref(undefined),
    isEditingLinkRef: ref(false),
    slashMenuRef: ref(null),
    filteredSlashCommandsRef: ref([]),
    selectedCommandIndexRef: ref(0),
    docLinkMenuRef: ref(null),
    filteredDocLinkRowsRef: ref([]),
    selectedDocLinkIndexRef: ref(0),
    handleLocalImagePickRef: ref(vi.fn()),
    handleEmojiPickRef: ref(vi.fn()),
    typedEmptyOrderedListMarkerRef: ref(false),
    cancelAutoFocusRef: ref(null),
    fileId: 'file-a',
    serializeTimerRef: ref(null),
    pendingEditGenerationRef: ref({ discarded: false }),
    isInitializingRef: ref(false),
    isApplyingProgrammaticUpdateRef: ref(false),
    markdownCommentsRef: ref([]),
    markdownSourceLineOffsetRef: ref(0),
    flushPendingSerialization: vi.fn(),
    openSearchRef: ref(vi.fn()),
    openAnnotationPopoverRef: ref(vi.fn()),
    addSelectionToLastAgentRef: ref(() => false),
    syncAnnotationTarget: vi.fn(),
    clearAnnotationTarget: vi.fn(),
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    setIsEditingLink: stateSetter<boolean>(),
    setLinkBubble: stateSetter<LinkBubbleState | null>(),
    setSelectedCommandIndex: stateSetter<number>(),
    setSelectedDocLinkIndex: stateSetter<number>(),
    setSlashMenu: stateSetter<SlashMenuState | null>(),
    setDocLinkMenu: stateSetter<DocLinkMenuState | null>(),
    ...overrides
  }
}

describe('rich Markdown DOM paste admission', () => {
  const editors: Editor[] = []

  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy())
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function pasteEditor() {
    vi.useFakeTimers()
    const saveClipboardImageAsTempFile = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { setMarkdownEditorFocused: vi.fn(), saveClipboardImageAsTempFile } }
    })
    const params = createConfigParams({ content: 'hello world\n\nother paragraph' })
    const config = createRichMarkdownEditorConfig(params)
    const editor = new Editor({
      ...config,
      extensions: createRichMarkdownExtensions({
        codec: params.codec,
        htmlSuperscriptLinks: true,
        htmlSuperscriptLinkContext: params.htmlSuperscriptLinkContext
      })
    })
    params.editorRef.current = editor
    document.body.append(editor.view.dom)
    editor.view.dom.focus()
    editor.commands.setTextSelection({ from: 7, to: 12 })
    editors.push(editor)
    const parser = DocumentParser.fromSchema(editor.schema)
    const parseSlice = vi.spyOn(parser, 'parseSlice')
    editor.setOptions({ editorProps: { ...config.editorProps, clipboardParser: parser } })
    return { editor, parseSlice, saveClipboardImageAsTempFile }
  }

  function paste(editor: Editor, text: string, html = ''): ClipboardEvent {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    if (html) {
      clipboardData.setData('text/html', html)
    }
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(event)
    return event
  }

  it('chunks a large HTML paste without building a clipboard slice', async () => {
    const { editor, parseSlice } = pasteEditor()
    const text = 'large paste '.repeat(6_000)

    expect(paste(editor, text, `<p>${text}</p>`).defaultPrevented).toBe(true)
    await vi.runAllTimersAsync()

    expect(editor.state.doc.firstChild?.textContent).toBe(`hello ${text}`)
    expect(editor.state.doc.child(1).textContent).toBe('other paragraph')
    expect(parseSlice).not.toHaveBeenCalled()
  })

  it('keeps source-rich clipboard content on the parsed preservation route', async () => {
    const { editor } = pasteEditor()
    const text = 'source '.repeat(10_000)
    const source = '<sup><a href="https://example.com">[1]</a></sup>'
    const document = editor.schema.node('doc', null, [
      editor.schema.node('paragraph', null, [
        editor.schema.text(text),
        editor.schema.node('richMarkdownHtmlSuperscriptLink', {
          source,
          href: 'https://example.com',
          label: '[1]',
          title: null
        })
      ])
    ])
    const html = editor.view.serializeForClipboard(document.slice(1, document.content.size - 1)).dom
      .innerHTML
    paste(editor, `${text}[1]`, html)
    await vi.runAllTimersAsync()

    expect(editor.getMarkdown()).toContain(source)
    expect(editor.state.doc.firstChild?.textContent).toBe(`hello ${text}`)
    let citations = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'richMarkdownHtmlSuperscriptLink') {
        citations += 1
      }
    })
    expect(citations).toBe(1)
  })
})

// @vitest-environment happy-dom
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { Editor } from '@tiptap/react'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import type { DocLinkMenuState } from './rich-markdown-commands'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import {
  createRichMarkdownEditorConfig,
  type EditorConfigParams
} from './rich-markdown-editor-config'
import type { SlashMenuState } from './rich-markdown-slash-commands'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function stateSetter<T>(): Dispatch<SetStateAction<T>> {
  return vi.fn() as Dispatch<SetStateAction<T>>
}

function getSpellcheckAttribute(config: ReturnType<typeof createRichMarkdownEditorConfig>): string {
  const attributes = config.editorProps?.attributes
  return typeof attributes === 'function'
    ? attributes({} as never).spellcheck
    : (attributes?.spellcheck ?? '')
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
    settings: { activeRuntimeEnvironmentId: null },
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
    serializeTimerRef: ref(null),
    isInitializingRef: ref(false),
    isApplyingProgrammaticUpdateRef: ref(false),
    markdownCommentsRef: ref([]),
    markdownSourceLineOffsetRef: ref(0),
    flushPendingSerialization: vi.fn(),
    openSearchRef: ref(vi.fn()),
    openAnnotationPopoverRef: ref(vi.fn()),
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

describe('createRichMarkdownEditorConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies Markdown through the configured DOM listener and keeps HTML', () => {
    const params = createConfigParams()
    const config = createRichMarkdownEditorConfig(params)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec: params.codec }),
      content: '**owned fixture**',
      contentType: 'markdown',
      editorProps: config.editorProps
    })
    params.editorRef.current = editor
    try {
      editor.commands.setTextSelection({ from: 1, to: 14 })
      const clipboardData = new DataTransfer()
      const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true })
      editor.view.dom.dispatchEvent(event)
      expect(clipboardData.getData('text/plain')).toBe('**owned fixture**')
      expect(clipboardData.getData('text/html')).toContain('<strong>owned fixture</strong>')
      expect(event.defaultPrevented).toBe(true)
    } finally {
      editor.destroy()
      params.editorRef.current = null
    }
  })

  it('disables browser spellcheck when the rich Markdown setting is off', () => {
    const config = createRichMarkdownEditorConfig(
      createConfigParams({ richMarkdownSpellcheckEnabled: false })
    )

    expect(getSpellcheckAttribute(config)).toBe('false')
  })

  it('keeps browser spellcheck enabled by default', () => {
    const config = createRichMarkdownEditorConfig(createConfigParams())

    expect(getSpellcheckAttribute(config)).toBe('true')
  })

  it('flushes pending serialization when the rich editor blurs', () => {
    const setMarkdownEditorFocused = vi.fn()
    vi.stubGlobal('window', {
      api: { ui: { setMarkdownEditorFocused } }
    })
    const flushPendingSerialization = vi.fn()
    const clearAnnotationTarget = vi.fn()
    const config = createRichMarkdownEditorConfig(
      createConfigParams({ clearAnnotationTarget, flushPendingSerialization })
    )

    config.onBlur?.({} as never)

    expect(setMarkdownEditorFocused).toHaveBeenCalledWith(false)
    expect(clearAnnotationTarget).toHaveBeenCalledOnce()
    expect(flushPendingSerialization).toHaveBeenCalledOnce()
  })
})

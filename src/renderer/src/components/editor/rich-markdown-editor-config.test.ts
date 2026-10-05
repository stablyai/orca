// @vitest-environment happy-dom
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
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

  it('serializes actual rich document edits throughout continuous typing', async () => {
    vi.useFakeTimers()
    const changed = vi.fn<(content: string) => void>()
    const params = createConfigParams({
      onContentChangeRef: ref(changed),
      reconcileRoundTripRef: ref((markdown: string) => markdown)
    })
    const editor = new Editor({
      ...createRichMarkdownEditorConfig(params),
      extensions: [StarterKit, Markdown]
    })
    params.editorRef.current = editor
    try {
      await vi.advanceTimersByTimeAsync(0)
      for (let index = 0; index < 20; index++) {
        editor.commands.insertContent('x')
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(changed.mock.calls.length).toBeGreaterThanOrEqual(4)
      expect(changed.mock.calls.at(-1)?.[0]).toBe(editor.getMarkdown())
      expect(editor.getMarkdown()).toContain('x'.repeat(20))
    } finally {
      editor.destroy()
      if (params.serializeTimerRef.current !== null) {
        window.clearTimeout(params.serializeTimerRef.current)
      }
      vi.useRealTimers()
    }
  })
})

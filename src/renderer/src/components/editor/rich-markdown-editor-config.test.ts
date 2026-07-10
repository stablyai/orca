import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { Editor } from '@tiptap/react'
import type { DocLinkMenuState } from './rich-markdown-commands'
import { describe, expect, it, vi } from 'vitest'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import {
  createRichMarkdownEditorConfig,
  type EditorConfigParams
} from './rich-markdown-editor-config'
import type { SlashMenuState } from './rich-markdown-slash-commands'

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
  return {
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
})

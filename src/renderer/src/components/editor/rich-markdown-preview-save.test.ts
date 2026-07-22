// @vitest-environment happy-dom

import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RichMarkdownEditor from './RichMarkdownEditor'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const lifecycleSpies = vi.hoisted(() => {
  let pendingFlush: (() => void) | null = null
  return {
    flush: vi.fn(() => {
      pendingFlush?.()
    }),
    registerPendingFlush: vi.fn((_fileId: string, flush: () => void) => {
      pendingFlush = flush
      return vi.fn(() => {
        if (pendingFlush === flush) {
          pendingFlush = null
        }
      })
    }),
    save: vi.fn().mockResolvedValue(undefined),
    reset: () => {
      pendingFlush = null
    }
  }
})
const editorSpies = vi.hoisted(() => ({
  onContentChange: vi.fn()
}))
const useEditor = vi.fn()
let editorMarkdown = 'original'
type TestEditor = {
  getMarkdown: () => string
  view: { dom: HTMLElement }
  state: {
    selection: {
      empty: boolean
      $from: { parentOffset: number; parent: { textBetween: () => string } }
    }
  }
}
type EditorConfig = {
  contentType: string
  onCreate: (args: { editor: TestEditor }) => void
  onUpdate: (args: { editor: TestEditor }) => void
  onBlur: () => void
}
const capturedConfigs: EditorConfig[] = []

vi.mock('@tiptap/react', () => ({
  useEditor: (config: EditorConfig) => {
    capturedConfigs.push(config)
    useEditor(config)
    return editor
  },
  useEditorState: () => null
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: {}, editorFontZoomLevel: 1, activateMarkdownLink: vi.fn() })
}))
vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffComments: () => []
}))
vi.mock('./editor-pending-flush', () => ({
  flushPendingEditorChange: lifecycleSpies.flush,
  registerPendingEditorFlush: lifecycleSpies.registerPendingFlush
}))
vi.mock('./editor-autosave', () => ({ requestEditorFileSave: lifecycleSpies.save }))
vi.mock('./RichMarkdownEditorSurface', () => ({
  RichMarkdownEditorSurface: () =>
    React.createElement('div', { 'data-testid': 'rich-editor-surface' })
}))
vi.mock('./useLocalImagePick', () => ({ useLocalImagePick: () => ({}) }))
vi.mock('./useRichMarkdownSearch', () => ({
  useRichMarkdownSearch: () => ({ openSearch: vi.fn(), searchState: null, searchActions: {} })
}))
vi.mock('./useLinkBubble', () => ({ useLinkBubble: () => ({}) }))
vi.mock('./useEditorScrollRestore', () => ({ useEditorScrollRestore: () => {} }))
vi.mock('./useModifierHeldClass', () => ({ useModifierHeldClass: () => {} }))
vi.mock('./use-rich-markdown-table-of-contents', () => ({
  useRichMarkdownTableOfContents: () => ({
    tableOfContentsItems: [],
    navigateToTableOfContentsItem: vi.fn()
  })
}))
vi.mock('./useRichMarkdownMenuController', () => ({
  useRichMarkdownMenuController: () => ({
    handleLocalImagePickRef: { current: vi.fn() },
    handleEmojiPickRef: { current: vi.fn() },
    slashMenu: null,
    slashMenuRef: { current: null },
    filteredSlashCommands: [],
    filteredSlashCommandsRef: { current: [] },
    docLinkMenu: null,
    docLinkMenuRef: { current: null },
    docLinkRows: [],
    docLinkTotalMatches: 0,
    filteredDocLinkRowsRef: { current: [] },
    emojiMenu: null,
    setEmojiMenu: vi.fn(),
    openEmojiMenu: vi.fn(),
    selectedCommandIndex: 0,
    selectedCommandIndexRef: { current: 0 },
    selectedDocLinkIndex: 0,
    selectedDocLinkIndexRef: { current: 0 },
    setSelectedCommandIndex: vi.fn(),
    setSelectedDocLinkIndex: vi.fn(),
    setSlashMenu: vi.fn(),
    setDocLinkMenu: vi.fn()
  })
}))
vi.mock('./useRichMarkdownProgrammaticSync', () => ({ useRichMarkdownProgrammaticSync: () => {} }))
vi.mock('./useRichMarkdownReconcileRoundTrip', () => ({
  useRichMarkdownReconcileRoundTrip: () => vi.fn()
}))
vi.mock('./useRichMarkdownReviewController', () => ({
  useRichMarkdownReviewController: () => ({
    addDiffComment: vi.fn(),
    markdownCommentsRef: { current: [] },
    markdownSourceLineOffsetRef: { current: 0 },
    markdownComments: [],
    activeReviewCommentId: null,
    attentionReviewCommentId: null,
    copiedReviewNoteId: null,
    notePositions: [],
    reviewRailExpanded: false,
    reviewRailOpen: false,
    reviewRailVisible: false,
    reviewNotesCopied: false,
    unsentMarkdownReviewScope: null,
    annotationTarget: null,
    annotationPopover: null,
    canAnnotateRichMarkdown: false,
    clearTransientReviewState: vi.fn(),
    openAnnotationPopover: vi.fn(),
    syncAnnotationTarget: vi.fn(),
    clearAnnotationTarget: vi.fn(),
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    clearAnnotationHighlight: vi.fn(),
    handleCopyMarkdownReviewNote: vi.fn(),
    handleCopyMarkdownReviewNotes: vi.fn(),
    scrollRichMarkdownReviewNoteSourceIntoView: vi.fn(),
    setAnnotationPopover: vi.fn(),
    setReviewRailOpen: vi.fn(),
    submitAnnotation: vi.fn(),
    syncNotePositions: vi.fn()
  })
}))
vi.mock('./useRichMarkdownReviewEditorEffects', () => ({
  useRichMarkdownReviewEditorEffects: () => {}
}))
vi.mock('./useRichMarkdownSuperscriptLinkSetup', () => ({
  useRichMarkdownSuperscriptLinkSetup: () => ({
    codec: createRichMarkdownEditorCodec('0123456789abcdef0123456789abcdef'),
    htmlSuperscriptLinkContext: {},
    worktreeRoot: null
  })
}))
vi.mock('./useRichMarkdownSpellcheckAttribute', () => ({
  useRichMarkdownSpellcheckAttribute: () => {}
}))
vi.mock('./rich-markdown-normalize', () => ({ normalizeEmptyListItems: vi.fn() }))
vi.mock('./rich-markdown-auto-focus', () => ({ autoFocusRichEditor: () => vi.fn() }))

const editor: TestEditor = {
  getMarkdown: () => editorMarkdown,
  view: { dom: document.createElement('div') },
  state: {
    selection: { empty: true, $from: { parentOffset: 0, parent: { textBetween: () => '' } } }
  }
}

function renderEditor() {
  window.api = {
    ui: {
      setMarkdownEditorFocused: vi.fn(),
      onRichMarkdownContextCommand: vi.fn(() => vi.fn())
    }
  } as unknown as typeof window.api
  return render(
    React.createElement(RichMarkdownEditor, {
      fileId: 'file-1',
      viewStateId: 'view-1',
      content: 'original',
      filePath: 'file.md',
      worktreeId: 'worktree-1',
      scrollCacheKey: 'file-1',
      onContentChange: editorSpies.onContentChange,
      onDirtyStateHint: vi.fn(),
      onSave: vi.fn()
    })
  )
}

describe('rich markdown preview lifecycle saves', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    capturedConfigs.length = 0
    useEditor.mockClear()
    lifecycleSpies.flush.mockClear()
    lifecycleSpies.registerPendingFlush.mockClear()
    lifecycleSpies.save.mockClear()
    lifecycleSpies.reset()
    editorSpies.onContentChange.mockClear()
    editorMarkdown = 'original'
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('saves preview edits on blur before the debounce publishes', async () => {
    const view = renderEditor()
    const config = capturedConfigs.at(-1)!

    act(() => config.onCreate({ editor }))
    editorMarkdown = 'edited'
    act(() => config.onUpdate({ editor }))
    act(() => vi.advanceTimersByTime(299))
    expect(lifecycleSpies.save).not.toHaveBeenCalled()
    expect(editorSpies.onContentChange).not.toHaveBeenCalled()

    act(() => config.onBlur())
    await Promise.resolve()

    expect(window.api.ui.setMarkdownEditorFocused).toHaveBeenCalledWith(false)
    expect(lifecycleSpies.flush).toHaveBeenCalledWith('file-1')
    expect(editorSpies.onContentChange).toHaveBeenCalledWith('edited')
    expect(lifecycleSpies.save).toHaveBeenCalledWith({ fileId: 'file-1' })
    view.unmount()
  })

  it('saves preview edits on unmount before the debounce publishes', async () => {
    const view = renderEditor()
    const config = capturedConfigs.at(-1)!

    act(() => config.onCreate({ editor }))
    editorMarkdown = 'edited'
    act(() => config.onUpdate({ editor }))
    act(() => vi.advanceTimersByTime(299))
    expect(lifecycleSpies.save).not.toHaveBeenCalled()
    expect(editorSpies.onContentChange).not.toHaveBeenCalled()
    view.unmount()
    await Promise.resolve()

    expect(lifecycleSpies.flush).toHaveBeenCalledWith('file-1')
    expect(editorSpies.onContentChange).toHaveBeenCalledWith('edited')
    expect(lifecycleSpies.save).toHaveBeenCalledWith({ fileId: 'file-1' })
  })

  it('does not save a clean preview buffer', () => {
    const view = renderEditor()
    const config = capturedConfigs.at(-1)!

    act(() => config.onBlur())
    view.unmount()
    expect(lifecycleSpies.flush).not.toHaveBeenCalled()
    expect(lifecycleSpies.save).not.toHaveBeenCalled()
  })
})

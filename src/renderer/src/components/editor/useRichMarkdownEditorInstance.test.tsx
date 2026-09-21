// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import type { EditorConfigParams } from './rich-markdown-editor-config'
import { useRichMarkdownEditorInstance } from './useRichMarkdownEditorInstance'

const { createExtensionsMock, createConfigMock, useEditorMock } = vi.hoisted(() => {
  const editorMock = { id: 'editor' }
  return {
    createExtensionsMock: vi.fn(() => ['extension']),
    createConfigMock: vi.fn(() => ({})),
    useEditorMock: vi.fn(() => editorMock as unknown as Editor)
  }
})

vi.mock('@tiptap/react', () => ({ useEditor: useEditorMock }))
vi.mock('./rich-markdown-extensions', () => ({
  createRichMarkdownExtensions: createExtensionsMock
}))
vi.mock('./rich-markdown-editor-config', () => ({
  createRichMarkdownEditorConfig: createConfigMock
}))

function createParams(content = ''): EditorConfigParams {
  return {
    codec: {} as EditorConfigParams['codec'],
    htmlSuperscriptLinkContext: {} as EditorConfigParams['htmlSuperscriptLinkContext'],
    content,
    filePath: '/repo/README.md',
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo',
    isMac: false,
    richMarkdownSpellcheckEnabled: true,
    settings: {} as EditorConfigParams['settings'],
    activateMarkdownLink: vi.fn(),
    rootRef: { current: null },
    editorRef: { current: null },
    lastCommittedMarkdownRef: { current: '' },
    originalSourceRef: { current: '' },
    baseCanonicalRef: { current: '' },
    reconcileRoundTripRef: { current: () => null },
    onContentChangeRef: { current: vi.fn() },
    onDirtyStateHintRef: { current: vi.fn() },
    onSaveRef: { current: vi.fn() },
    onOpenDocLinkRef: { current: undefined },
    isEditingLinkRef: { current: false },
    slashMenuRef: { current: null },
    filteredSlashCommandsRef: { current: [] },
    selectedCommandIndexRef: { current: 0 },
    docLinkMenuRef: { current: null },
    filteredDocLinkRowsRef: { current: [] },
    selectedDocLinkIndexRef: { current: 0 },
    handleLocalImagePickRef: { current: vi.fn() },
    handleEmojiPickRef: { current: vi.fn() },
    typedEmptyOrderedListMarkerRef: { current: false },
    cancelAutoFocusRef: { current: null },
    serializeTimerRef: { current: null },
    isInitializingRef: { current: false },
    isApplyingProgrammaticUpdateRef: { current: false },
    markdownCommentsRef: { current: [] },
    markdownSourceLineOffsetRef: { current: 0 },
    flushPendingSerialization: vi.fn(),
    openSearchRef: { current: vi.fn() },
    openAnnotationPopoverRef: { current: vi.fn() },
    syncAnnotationTarget: vi.fn(),
    clearAnnotationTarget: vi.fn(),
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    setIsEditingLink: vi.fn(),
    setLinkBubble: vi.fn(),
    setSelectedCommandIndex: vi.fn(),
    setSelectedDocLinkIndex: vi.fn(),
    setSlashMenu: vi.fn(),
    setDocLinkMenu: vi.fn()
  }
}

describe('useRichMarkdownEditorInstance', () => {
  beforeEach(() => {
    createExtensionsMock.mockClear()
    createConfigMock.mockClear()
    useEditorMock.mockClear()
  })

  it('does not rebuild Tiptap when ordinary editor options change', () => {
    const initialParams = createParams('initial')
    const { rerender, result } = renderHook(({ params }) => useRichMarkdownEditorInstance(params), {
      initialProps: { params: initialParams }
    })

    const nextParams = { ...initialParams, content: 'updated' }
    rerender({ params: nextParams })

    expect(result.current).toBe(useEditorMock.mock.results[0]?.value)
    expect(createExtensionsMock).toHaveBeenCalledOnce()
    expect(useEditorMock).toHaveBeenCalledTimes(2)
    const editorCalls = useEditorMock.mock.calls as unknown[][]
    expect(editorCalls[0]?.[1]).toEqual([])
    expect(editorCalls[1]?.[1]).toEqual([])
    expect(createConfigMock).toHaveBeenCalledTimes(2)
  })
})

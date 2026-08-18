// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { editor as MonacoEditor } from 'monaco-editor'

const storeFixture = vi.hoisted(() => ({
  activeGroupIdByWorktree: {},
  clearDeliveredDiffComments: vi.fn(),
  keybindings: { 'editor.addReviewNote': ['Ctrl+L'] }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture),
    { getState: () => storeFixture }
  )
}))

import { useDiffCommentDecorator } from './useDiffCommentDecorator'

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('useDiffCommentDecorator model lifecycle', () => {
  it('rebuilds model-scoped resources when a retained editor swaps models', () => {
    const editorDomNode = document.createElement('div')
    document.body.appendChild(editorDomNode)
    const disposeMouseMove = vi.fn()
    const disposeMouseLeave = vi.fn()
    const disposeScroll = vi.fn()
    const editor = {
      getDomNode: () => editorDomNode,
      getOption: () => 19,
      onMouseMove: () => ({ dispose: disposeMouseMove }),
      onMouseLeave: () => ({ dispose: disposeMouseLeave }),
      onDidScrollChange: () => ({ dispose: disposeScroll }),
      changeViewZones: (callback: (accessor: object) => void) => callback({})
    } as unknown as MonacoEditor.ICodeEditor
    const hook = renderHook(
      ({ monacoModelIdentity }) =>
        useDiffCommentDecorator({
          editor,
          monacoModelIdentity,
          filePath: 'notes.ts',
          worktreeId: 'worktree-1',
          comments: [],
          onAddCommentClick: vi.fn(),
          onDeleteComment: vi.fn()
        }),
      { initialProps: { monacoModelIdentity: 'modified-v1' } }
    )
    const firstButton = editorDomNode.querySelector('.orca-diff-comment-add-btn')

    hook.rerender({ monacoModelIdentity: 'modified-v2' })

    const replacementButton = editorDomNode.querySelector('.orca-diff-comment-add-btn')
    expect(replacementButton).not.toBeNull()
    expect(replacementButton).not.toBe(firstButton)
    expect(disposeMouseMove).toHaveBeenCalledOnce()
    expect(disposeMouseLeave).toHaveBeenCalledOnce()
    expect(disposeScroll).toHaveBeenCalledOnce()
  })

  it('opens a diff note from the configured shortcut and preserves an open draft', () => {
    const editorDomNode = document.createElement('div')
    const input = document.createElement('textarea')
    editorDomNode.appendChild(input)
    document.body.appendChild(editorDomNode)
    let positionLine = 4
    const editor = {
      getDomNode: () => editorDomNode,
      getModel: () => ({ getLineCount: () => 8 }),
      getOption: () => 20,
      getPosition: () => ({ lineNumber: positionLine, column: 1 }),
      getScrollTop: () => 10,
      getSelection: () => null,
      getTopForLineNumber: (lineNumber: number) => lineNumber * 20,
      onMouseMove: () => ({ dispose: vi.fn() }),
      onMouseLeave: () => ({ dispose: vi.fn() }),
      onDidScrollChange: () => ({ dispose: vi.fn() }),
      changeViewZones: (callback: (accessor: object) => void) => callback({})
    } as unknown as MonacoEditor.ICodeEditor
    const onAddCommentClick = vi.fn()
    const hook = renderHook(
      ({ isAddCommentDraftOpen }) =>
        useDiffCommentDecorator({
          editor,
          filePath: 'notes.ts',
          worktreeId: 'worktree-1',
          comments: [],
          commentableLineNumbers: [4, 5],
          enableAddReviewNoteShortcut: true,
          isAddCommentDraftOpen,
          onAddCommentClick,
          onDeleteComment: vi.fn()
        }),
      { initialProps: { isAddCommentDraftOpen: false } }
    )
    const event = new KeyboardEvent('keydown', {
      key: 'l',
      code: 'KeyL',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(onAddCommentClick).toHaveBeenCalledWith({
      lineNumber: 4,
      startLine: undefined,
      top: 90
    })

    hook.rerender({ isAddCommentDraftOpen: true })
    positionLine = 5
    const openDraftEvent = new KeyboardEvent('keydown', {
      key: 'l',
      code: 'KeyL',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
    input.dispatchEvent(openDraftEvent)

    expect(openDraftEvent.defaultPrevented).toBe(true)
    expect(onAddCommentClick).toHaveBeenCalledOnce()

    hook.unmount()
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'l',
        code: 'KeyL',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    expect(onAddCommentClick).toHaveBeenCalledOnce()
  })
})

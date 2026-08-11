// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { editor as MonacoEditor } from 'monaco-editor'

const storeFixture = vi.hoisted(() => ({
  activeGroupIdByWorktree: {},
  clearDeliveredDiffComments: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture)
}))

// Why: the real monaco-setup top-level-awaits monaco-editor plus worker/css
// assets, which vitest cannot evaluate; the hook only needs these two APIs.
vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    editor: { EditorOption: { lineHeight: 66 } },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number
      ) {}
    }
  }
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
})

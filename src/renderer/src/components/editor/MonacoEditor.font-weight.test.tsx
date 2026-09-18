// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
const storeState = vi.hoisted(() => ({
  current: {
    theme: 'dark',
    terminalFontSize: 13,
    terminalFontWeight: 500,
    editorFontWeight: 0
  } as Record<string, unknown>
}))

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: storeState.current,
      editorFontZoomLevel: 0,
      setPendingEditorReveal: vi.fn(),
      setEditorCursorLine: vi.fn(),
      addDiffComment: vi.fn(),
      deleteDiffComment: vi.fn(),
      updateDiffComment: vi.fn(),
      scrollToDiffCommentId: null,
      setScrollToDiffCommentId: vi.fn(),
      worktreeDiffComments: {}
    })
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))

import MonacoEditor from './MonacoEditor'

function renderEditor(): void {
  render(
    <MonacoEditor
      fileId="file"
      filePath="/repo/file.ts"
      viewStateKey="pane:file"
      relativePath="file.ts"
      content="const answer = 42"
      language="typescript"
      onContentChange={vi.fn()}
      onSave={vi.fn()}
      readOnly
    />
  )
}

function renderedFontWeight(): unknown {
  const options = editorProps.current?.options as Record<string, unknown> | undefined
  return options?.fontWeight
}

afterEach(() => {
  cleanup()
  editorProps.current = null
})

describe('MonacoEditor font weight', () => {
  it('follows the terminal weight when no editor weight override is set', () => {
    storeState.current = {
      theme: 'dark',
      terminalFontSize: 13,
      terminalFontWeight: 600,
      editorFontWeight: 0
    }
    renderEditor()
    expect(renderedFontWeight()).toBe('600')
  })

  it('uses the opt-in editor weight override instead of the terminal weight', () => {
    storeState.current = {
      theme: 'dark',
      terminalFontSize: 13,
      terminalFontWeight: 600,
      editorFontWeight: 300
    }
    renderEditor()
    expect(renderedFontWeight()).toBe('300')
  })
})

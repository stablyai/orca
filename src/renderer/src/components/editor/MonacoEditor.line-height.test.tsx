// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
const storeState = vi.hoisted(() => ({
  current: {
    theme: 'dark',
    terminalFontSize: 13,
    terminalFontFamily: 'monospace'
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

function renderEditor(): Record<string, unknown> | undefined {
  render(
    <MonacoEditor
      fileId="file"
      filePath="/repo/file.py"
      viewStateKey="pane:file"
      relativePath="file.py"
      content="print('hi')"
      language="python"
      onContentChange={vi.fn()}
      onSave={vi.fn()}
      readOnly
    />
  )
  return editorProps.current?.options as Record<string, unknown> | undefined
}

afterEach(() => {
  cleanup()
  editorProps.current = null
})

describe('MonacoEditor line height', () => {
  it('keeps the documented default of 1 when terminal Line Height is unset', () => {
    storeState.current = {
      theme: 'dark',
      terminalFontSize: 13,
      terminalFontFamily: 'monospace'
    }
    const options = renderEditor()
    expect(options?.lineHeight).toBe(13)
  })

  it('derives constructed lineHeight from the terminal Line Height setting', () => {
    storeState.current = {
      theme: 'dark',
      terminalFontSize: 13,
      terminalFontFamily: 'monospace',
      terminalLineHeight: 1.35
    }
    const options = renderEditor()
    expect(options?.lineHeight).toBe(17.55)
  })
})

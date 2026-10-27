// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type EditorProps = { current: Record<string, unknown> | null }
type StoreState = { settings: Record<string, unknown>; editorFontZoomLevel: number }

const editorProps = vi.hoisted((): EditorProps => ({ current: null }))
const storeState = vi.hoisted((): StoreState => ({
  settings: { theme: 'dark', terminalFontSize: 13 },
  editorFontZoomLevel: 0
}))

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/lib/monaco-setup', () => ({}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: storeState.settings,
      editorFontZoomLevel: storeState.editorFontZoomLevel,
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

function renderedFontSize(settings: Record<string, unknown>, editorFontZoomLevel = 0): unknown {
  storeState.settings = { theme: 'dark', ...settings }
  storeState.editorFontZoomLevel = editorFontZoomLevel
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
  const options = editorProps.current?.options
  return typeof options === 'object' && options !== null && 'fontSize' in options
    ? options.fontSize
    : undefined
}

afterEach(() => {
  cleanup()
  editorProps.current = null
})

describe('MonacoEditor font size', () => {
  it('follows the terminal font size when no editor font size is set', () => {
    expect(renderedFontSize({ terminalFontSize: 13 })).toBe(13)
  })

  it('uses the opt-in editor font size instead of the terminal font size', () => {
    expect(renderedFontSize({ terminalFontSize: 13, editorFontSize: 18 })).toBe(18)
  })

  it('applies editor zoom on top of the editor font size', () => {
    expect(renderedFontSize({ terminalFontSize: 13, editorFontSize: 18 }, 2)).toBe(20)
  })
})

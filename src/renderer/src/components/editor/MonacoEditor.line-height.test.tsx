// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
const storeState = vi.hoisted(() => ({
  current: { theme: 'dark', terminalFontSize: 13, editorLineHeight: 0 } as Record<string, unknown>
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

function renderedLineHeight(): unknown {
  const options = editorProps.current?.options as Record<string, unknown> | undefined
  return options?.lineHeight
}

afterEach(() => {
  cleanup()
  editorProps.current = null
})

describe('MonacoEditor line height', () => {
  // Monaco reads 0 as "compute the line height from the font size", so an untouched
  // profile must keep exactly the spacing it had before this setting existed.
  it('leaves Monaco automatic spacing when the setting is untouched', () => {
    storeState.current = { theme: 'dark', terminalFontSize: 13, editorLineHeight: 0 }
    renderEditor()
    expect(renderedLineHeight()).toBe(0)
  })

  it('passes the opted-in multiplier through to Monaco', () => {
    storeState.current = { theme: 'dark', terminalFontSize: 13, editorLineHeight: 1.2 }
    renderEditor()
    expect(renderedLineHeight()).toBe(1.2)
  })
})

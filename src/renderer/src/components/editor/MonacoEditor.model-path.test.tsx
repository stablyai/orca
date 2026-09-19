// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Uri } from 'monaco-editor'
import type { OpenFile } from '@/store/slices/editor'
import { disposeClosedEditorTabs } from './closed-editor-tab-disposal'
import { createMonacoModelRegistryWithRealUri } from './monaco-model-registry-test-fixture'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    // Why: @monaco-editor/react resolves `path` with this exact call before creating the model.
    Uri.parse(String(props.path))
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { theme: 'dark', terminalFontSize: 13 },
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

const WSL_COLON_PATH =
  '\\\\wsl.localhost\\Ubuntu-26.04\\home\\mj\\projects\\acp-client\\notes:2026.md'

function renderEditor(filePath: string): void {
  render(
    <MonacoEditor
      fileId="file"
      filePath={filePath}
      viewStateKey="pane:file"
      relativePath="notes:2026.md"
      content="# notes"
      language="markdown"
      onContentChange={vi.fn()}
      onSave={vi.fn()}
      readOnly
    />
  )
}

afterEach(() => {
  cleanup()
  editorProps.current = null
})

describe('MonacoEditor model path', () => {
  it('passes ordinary paths through unchanged', () => {
    renderEditor('/repo/file.py')
    expect(editorProps.current?.path).toBe('/repo/file.py')
  })

  it('hands Monaco a parseable path for a WSL/UNC file name carrying a colon', () => {
    expect(() => renderEditor(WSL_COLON_PATH)).not.toThrow()
    expect(() => Uri.parse(String(editorProps.current?.path))).not.toThrow()
  })

  // Why through the rendered prop, not the helper: this is the only assertion that fails if
  // MonacoEditor stops routing `path` through the helper and the close-all key drifts.
  it('keys the model on a path close-all can still dispose', () => {
    renderEditor(WSL_COLON_PATH)
    const renderedPath = String(editorProps.current?.path)
    const registry = createMonacoModelRegistryWithRealUri([renderedPath])

    disposeClosedEditorTabs(registry, [
      { id: 'poisoned', mode: 'edit', filePath: WSL_COLON_PATH } as OpenFile
    ])

    expect(registry.disposed).toEqual([renderedPath])
  })
})

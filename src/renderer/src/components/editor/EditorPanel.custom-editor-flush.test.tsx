// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { EditorToggleValue } from './EditorViewToggle'
import { registerEditorFrameFlush } from './editor-pending-flush'

vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: {},
    diffContents: {},
    reloadContent: () => {}
  })
}))

vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: ({
    onEditorToggleChange
  }: {
    onEditorToggleChange: (value: EditorToggleValue) => void
  }) => <button onClick={() => onEditorToggleChange('source')}>Source</button>
}))

import EditorPanel from './EditorPanel'

const initialState = useAppStore.getInitialState()
const filePath = '/repo/notes.md'
const file: OpenFile = {
  id: filePath,
  filePath,
  relativePath: 'notes.md',
  worktreeId: 'wt',
  language: 'markdown',
  mode: 'edit',
  isDirty: false,
  runtimeEnvironmentId: null
}
let container: HTMLDivElement
let root: Root

describe('switching away from a custom editor', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialState, true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialState, true)
  })

  it('switches only after the mounted frame flushed its pending edits', async () => {
    let answer: (flushed: boolean) => void = () => {}
    const unregister = registerEditorFrameFlush(
      file.id,
      () => new Promise((resolve) => (answer = resolve))
    )
    try {
      useAppStore.setState({
        openFiles: [file],
        activeFileId: file.id,
        activeWorktreeId: file.worktreeId,
        markdownViewMode: { [file.id]: 'rich' }
      })
      await act(async () => root.render(<EditorPanel />))
      await act(async () => container.querySelector('button')?.click())
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('rich')
      await act(async () => answer(true))
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('source')
    } finally {
      unregister()
    }
  })
})

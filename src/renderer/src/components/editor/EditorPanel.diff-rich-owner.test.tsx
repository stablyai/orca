// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { buildOwnedEditorFileId } from '@/store/slices/editor/file-ids/editor-file-ids'
import type { EditorToggleValue } from './EditorViewToggle'

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
  }) => <button onClick={() => onEditorToggleChange('rich')}>Rich Editor</button>
}))

import EditorPanel from './EditorPanel'

const initialState = useAppStore.getInitialState()
const filePath = '/repo/notes.md'
let container: HTMLDivElement
let root: Root

function file(overrides: Partial<OpenFile>): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: 'notes.md',
    worktreeId: 'wt-target',
    language: 'markdown',
    mode: 'edit',
    isDirty: false,
    runtimeEnvironmentId: null,
    ...overrides
  }
}

describe('Rich Editor from a diff', () => {
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

  it('sets the mode on an existing scoped source tab without changing the same-path owner', async () => {
    const owner = { worktreeId: 'wt-target', runtimeEnvironmentId: null }
    const targetId = buildOwnedEditorFileId(filePath, owner.worktreeId, owner.runtimeEnvironmentId)
    const target = file({ ...owner, id: targetId })
    const other = file({ worktreeId: 'wt-other' })
    const diff = file({ ...owner, id: 'diff-target', mode: 'diff', diffSource: 'unstaged' })
    useAppStore.setState({
      openFiles: [other, target, diff],
      activeFileId: diff.id,
      activeWorktreeId: owner.worktreeId,
      markdownViewMode: { [other.id]: 'source', [target.id]: 'source' },
      editorViewMode: { [other.id]: 'changes', [target.id]: 'changes' }
    })
    await act(async () => root.render(<EditorPanel />))
    await act(async () => container.querySelector('button')?.click())

    const state = useAppStore.getState()
    expect(state.activeFileId).toBe(targetId)
    expect(state.markdownViewMode[targetId]).toBe('rich')
    expect(state.editorViewMode[targetId]).toBeUndefined()
    expect(state.markdownViewMode[other.id]).toBe('source')
    expect(state.editorViewMode[other.id]).toBe('changes')
  })

  it('opens a new scoped source tab without changing the same-path owner', async () => {
    const owner = { worktreeId: 'wt-target', runtimeEnvironmentId: 'runtime-target' }
    const other = file({ worktreeId: 'wt-other' })
    const diff = file({ ...owner, id: 'diff-target', mode: 'diff', diffSource: 'unstaged' })
    useAppStore.setState({
      openFiles: [other, diff],
      activeFileId: diff.id,
      activeWorktreeId: owner.worktreeId,
      markdownViewMode: { [other.id]: 'source' }
    })
    await act(async () => root.render(<EditorPanel />))
    await act(async () => container.querySelector('button')?.click())

    const state = useAppStore.getState()
    const opened = state.openFiles.find((entry) => entry.id === state.activeFileId)
    expect(opened).toMatchObject({ ...owner, filePath, mode: 'edit' })
    expect(opened?.id).not.toBe(other.id)
    expect(state.markdownViewMode[opened?.id ?? '']).toBe('rich')
    expect(state.markdownViewMode[other.id]).toBe('source')
  })
})

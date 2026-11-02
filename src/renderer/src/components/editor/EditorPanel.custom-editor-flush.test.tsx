// @vitest-environment happy-dom
import { act, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { EditorToggleValue } from './view-mode/EditorViewToggle'
import { registerEditorFrameFlush } from './save/flush/editor-pending-flush'

vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: {},
    diffContents: {},
    reloadContent: () => {}
  })
}))

vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: ({
    onEditorToggleChange,
    panelRef
  }: {
    onEditorToggleChange: (value: EditorToggleValue) => void
    panelRef: Ref<HTMLDivElement>
  }) => (
    <div ref={panelRef}>
      <button data-testid="source" onClick={() => onEditorToggleChange('source')}>
        Source
      </button>
      <button data-testid="changes" onClick={() => onEditorToggleChange('changes')}>
        Changes
      </button>
      <button data-testid="shortcut-target" type="button">
        Editor
      </button>
    </div>
  )
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
let didUnmount: boolean

describe('switching away from a custom editor', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialState, true)
    didUnmount = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (!didUnmount) {
      await act(async () => root.unmount())
    }
    document.body.replaceChildren()
    useAppStore.setState(initialState, true)
  })

  async function openEditor(fileToOpen: OpenFile = file): Promise<void> {
    await act(async () =>
      useAppStore.setState({
        openFiles: [fileToOpen],
        activeFileId: fileToOpen.id,
        activeWorktreeId: fileToOpen.worktreeId,
        markdownViewMode: { [fileToOpen.id]: 'rich' }
      })
    )
    await act(async () => root.render(<EditorPanel />))
  }

  function button(testId: string): HTMLButtonElement {
    const target = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
    if (!target) {
      throw new Error(`missing ${testId} button`)
    }
    return target
  }

  it('waits for a successful frame flush and keeps the handed-off draft', async () => {
    let answer: (flushed: boolean) => void = () => {}
    const unregister = registerEditorFrameFlush(
      file.id,
      () => new Promise((resolve) => (answer = resolve))
    )
    try {
      await openEditor()
      await act(async () => button('source').click())
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('rich')
      await act(async () =>
        useAppStore.getState().setEditorDraft(file.id, 'draft returned by the editor frame')
      )
      await act(async () => answer(true))
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('source')
      expect(useAppStore.getState().editorDrafts[file.id]).toBe(
        'draft returned by the editor frame'
      )
    } finally {
      unregister()
    }
  })

  it.each(['false', 'rejected'] as const)(
    'keeps the current view when an editor frame flush is %s',
    async (result) => {
      let resolveFlush: (flushed: boolean) => void = () => {}
      let rejectFlush: (reason: Error) => void = () => {}
      const unregister = registerEditorFrameFlush(
        file.id,
        () =>
          new Promise((resolve, reject) => {
            resolveFlush = resolve
            rejectFlush = reject
          })
      )
      try {
        await openEditor()
        await act(async () => button('source').click())
        await act(async () =>
          result === 'false' ? resolveFlush(false) : rejectFlush(new Error('flush failed'))
        )
        expect(useAppStore.getState().markdownViewMode[file.id]).toBe('rich')
        expect(useAppStore.getState().editorViewMode[file.id]).toBeUndefined()
      } finally {
        unregister()
      }
    }
  )

  it('routes the keyboard command through the same guarded flush path', async () => {
    let answer: (flushed: boolean) => void = () => {}
    const unregister = registerEditorFrameFlush(
      file.id,
      () => new Promise((resolve) => (answer = resolve))
    )
    try {
      useAppStore.setState({ keybindings: { 'editor.toggleChanges': ['Ctrl+Alt+C'] } })
      await openEditor()
      const event = new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true
      })
      await act(async () => button('shortcut-target').dispatchEvent(event))
      expect(event.defaultPrevented).toBe(true)
      expect(useAppStore.getState().editorViewMode[file.id]).toBeUndefined()
      await act(async () => answer(false))
      expect(useAppStore.getState().editorViewMode[file.id]).toBeUndefined()
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('rich')
    } finally {
      unregister()
    }
  })

  it('does not apply a pending view change after the original file closes', async () => {
    let answer: (flushed: boolean) => void = () => {}
    const unregister = registerEditorFrameFlush(
      file.id,
      () => new Promise((resolve) => (answer = resolve))
    )
    try {
      await openEditor()
      await act(async () => button('source').click())
      await act(async () => useAppStore.setState({ openFiles: [], activeFileId: null }))
      await act(async () => answer(true))
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('rich')
      expect(useAppStore.getState().editorViewMode[file.id]).toBeUndefined()
    } finally {
      unregister()
    }
  })

  it('does not apply a pending view change when the same file id changes owner', async () => {
    let answer: (flushed: boolean) => void = () => {}
    const unregister = registerEditorFrameFlush(
      file.id,
      () => new Promise((resolve) => (answer = resolve))
    )
    try {
      await openEditor()
      await act(async () => button('source').click())
      const replacement = { ...file, worktreeId: 'other-wt', runtimeEnvironmentId: 'remote' }
      await openEditor(replacement)
      await act(async () => answer(true))
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('rich')
      expect(useAppStore.getState().editorViewMode[file.id]).toBeUndefined()
    } finally {
      unregister()
    }
  })

  it('does not revive a pending change after the same file id closes and reopens', async () => {
    let answer: (flushed: boolean) => void = () => {}
    const unregister = registerEditorFrameFlush(
      file.id,
      () => new Promise((resolve) => (answer = resolve))
    )
    try {
      await openEditor()
      await act(async () => button('source').click())
      await act(async () => useAppStore.setState({ openFiles: [], activeFileId: null }))
      await act(async () => root.render(<EditorPanel />))
      await openEditor()
      await act(async () => answer(true))
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('rich')
      expect(useAppStore.getState().editorViewMode[file.id]).toBeUndefined()
    } finally {
      unregister()
    }
  })

  it('ignores an older view request when two frame flushes settle out of order', async () => {
    const answers: ((flushed: boolean) => void)[] = []
    const unregister = registerEditorFrameFlush(
      file.id,
      () => new Promise((resolve) => answers.push(resolve))
    )
    try {
      await openEditor()
      await act(async () => button('source').click())
      await act(async () => button('changes').click())
      expect(answers).toHaveLength(2)
      await act(async () => answers[1](true))
      expect(useAppStore.getState().editorViewMode[file.id]).toBe('changes')
      await act(async () => answers[0](true))
      expect(useAppStore.getState().editorViewMode[file.id]).toBe('changes')
      expect(useAppStore.getState().markdownViewMode[file.id]).toBe('rich')
    } finally {
      unregister()
    }
  })
})

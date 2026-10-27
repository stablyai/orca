// @vitest-environment happy-dom
// Workspace-scoped discards must evict every view of the shared record, including other workspaces.
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from './editor-autosave'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { useEditorPanelExternalContentEvents } from './useEditorPanelExternalContentEvents'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeRef.current!.getState() }
}))

type Calls = {
  invalidate: ReturnType<typeof vi.fn<(fileIds: string[]) => void>>
  loadFile: ReturnType<
    typeof vi.fn<Parameters<typeof useEditorPanelExternalContentEvents>[0]['loadFileContent']>
  >
}

function PanelProbe({
  openFiles,
  isVisible,
  calls
}: {
  openFiles: OpenFile[]
  isVisible: boolean
  calls: Calls
}): null {
  const activeContentFileIdRef = useRef(openFiles[0].id)
  const isVisibleRef = useRef(isVisible)
  const openFilesRef = useRef(openFiles)
  const editorViewModeRef = useRef({})
  const [, setFileContents] = useState<Record<string, FileContent>>({})
  const [, setDiffContents] = useState<Record<string, DiffContent>>({})
  useEditorPanelExternalContentEvents({
    activeContentFileIdRef,
    editorViewModeRef,
    invalidateContent: calls.invalidate,
    invalidateDiffContent: vi.fn(),
    isVisibleRef,
    loadDiffContent: vi.fn(async () => undefined),
    loadFileContent: calls.loadFile,
    openFilesRef,
    setDiffContents,
    setFileContents
  })
  return null
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function openInTwoWorkspaces(): { a: OpenFile; b: OpenFile } {
  const store = createEditorStore()
  storeRef.current = store
  store.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
  for (const worktreeId of ['wt-1', 'wt-2']) {
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId,
      language: 'markdown',
      mode: 'edit'
    })
  }
  const [a, b] = store.getState().openFiles
  return { a, b }
}

function discardInWorkspaceA(): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
        detail: { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'notes.md' }
      })
    )
  })
}

it.each([
  ['hidden', false],
  ['visible', true]
] as const)(
  "a change named by workspace A reaches B's %s view of the record",
  (_label, visible) => {
    const { b } = openInTwoWorkspaces()
    const calls: Calls = { invalidate: vi.fn(), loadFile: vi.fn(async () => undefined) }
    act(() => root.render(<PanelProbe openFiles={[b]} isVisible={visible} calls={calls} />))

    discardInWorkspaceA()

    if (visible) {
      expect(calls.loadFile).toHaveBeenCalledWith(
        b.filePath,
        b.id,
        b.worktreeId,
        b.relativePath,
        expect.objectContaining({ force: true })
      )
    } else {
      expect(calls.invalidate).toHaveBeenCalledWith([b.id])
    }
  }
)

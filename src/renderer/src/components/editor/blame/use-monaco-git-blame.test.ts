// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { create } from 'zustand'
import { afterEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { useMonacoGitBlame } from './use-monaco-git-blame'

type FakeState = {
  openFiles: { id: string }[]
  activeFileId: string | null
  activeTabType: string
  gitStatusHeadByWorktree: Record<string, string>
  statusBarVisible: boolean
  statusBarItems: string[]
}

const store = vi.hoisted((): { current: unknown } => ({ current: null }))
const blame = vi.hoisted(() => vi.fn())

vi.mock('@/store/index', () => ({
  get useAppStore() {
    return store.current
  }
}))
vi.mock('@/runtime/source-control/git/runtime-git-blame-client', () => ({
  getRuntimeGitBlame: blame
}))
vi.mock('../view-mode/editor-panel-file-mode', () => ({ canUseChangesModeForFile: () => true }))
vi.mock('./git-blame-target', () => ({
  openFileById: (files: { id: string }[], id: string) => files.find((file) => file.id === id),
  resolveGitBlameTarget: (_state: unknown, file: { id: string }) => ({
    git: { target: { kind: 'local' }, worktreeId: 'wt', worktreePath: '/repo', connectionId: null },
    relativePath: file.id
  })
}))

afterEach(() => {
  cleanup()
  blame.mockReset()
})

function fakeEditor(id: string): editor.IStandaloneCodeEditor {
  const disposable = { dispose: () => {} }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only these members.
  return {
    getId: () => id,
    hasTextFocus: () => false,
    getModel: () => null,
    getPosition: () => null,
    createDecorationsCollection: () => ({ set: () => {}, clear: () => {} }),
    onDidChangeModelContent: () => disposable,
    onDidChangeCursorPosition: () => disposable,
    onDidFocusEditorText: () => disposable
  } as unknown as editor.IStandaloneCodeEditor
}

it('runs git blame only for the front editor among many mounted ones', async () => {
  blame.mockResolvedValue({ kind: 'unavailable' })
  const fileIds = Array.from({ length: 10 }, (_, index) => `file-${index}.ts`)
  const useStore = create<FakeState>(() => ({
    openFiles: fileIds.map((id) => ({ id })),
    activeFileId: 'file-0.ts',
    activeTabType: 'editor',
    gitStatusHeadByWorktree: { wt: 'head-a' },
    statusBarVisible: true,
    statusBarItems: ['git-blame']
  }))
  store.current = useStore
  for (const [index, fileId] of fileIds.entries()) {
    renderHook(() =>
      useMonacoGitBlame({
        mountedEditor: fakeEditor(`editor-${index}`),
        fileId,
        passiveMirror: false,
        inlineEnabled: true
      })
    )
  }
  await act(async () => {})
  expect(blame.mock.calls.map((call) => call[1])).toEqual(['file-0.ts'])

  await act(async () => useStore.setState({ gitStatusHeadByWorktree: { wt: 'head-b' } }))
  expect(blame).toHaveBeenCalledTimes(2)

  // A hidden editor owes its blame and loads it once it becomes the active file.
  await act(async () => useStore.setState({ activeFileId: 'file-3.ts' }))
  expect(blame.mock.calls.map((call) => call[1])).toEqual(['file-0.ts', 'file-0.ts', 'file-3.ts'])

  // A terminal in front keeps the remembered file id, but nothing shows blame then.
  await act(async () => useStore.setState({ activeTabType: 'terminal' }))
  await act(async () => useStore.setState({ gitStatusHeadByWorktree: { wt: 'head-c' } }))
  expect(blame).toHaveBeenCalledTimes(3)
  await act(async () => useStore.setState({ activeTabType: 'editor' }))
  expect(blame.mock.calls.map((call) => call[1])).toEqual([
    'file-0.ts',
    'file-0.ts',
    'file-3.ts',
    'file-3.ts'
  ])
})

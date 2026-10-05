import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type * as Autosave from '@/components/editor/editor-autosave'
import { notifyEditorExternalFileChange } from '@/components/editor/editor-autosave'
import {
  buildEditorExternalWatchEventHandler,
  collectOverflowEditorExternalReloadTargets
} from './editor-external-watch-event-reconciliation'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

const state = vi.hoisted(
  (): { openFiles: OpenFile[]; setExternalMutation: ReturnType<typeof vi.fn> } => ({
    openFiles: [],
    setExternalMutation: vi.fn()
  })
)
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof Autosave>()),
  notifyEditorExternalFileChange: vi.fn()
}))

function file(filePath: string, isDirty = false): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: '../workspace-relative.md',
    worktreeId: 'owner',
    language: 'markdown',
    mode: 'edit',
    isDirty
  }
}
function target(worktreePath: string): EditorExternalWatchTarget {
  return {
    worktreeId: 'owner',
    worktreePath,
    connectionId: undefined,
    runtimeEnvironmentId: null,
    shallow: true
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  state.openFiles = [file('/first/notes.md'), file('/second/notes.md')]
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('reloads same-named files in two directories within one debounce interval', () => {
  const handler = buildEditorExternalWatchEventHandler((root) => target(root))
  for (const worktreePath of ['/first', '/second']) {
    handler.handleFsChanged({
      worktreePath,
      shallow: true,
      events: [{ kind: 'update', absolutePath: `${worktreePath}/notes.md` }]
    })
  }
  vi.advanceTimersByTime(100)
  expect(notifyEditorExternalFileChange).toHaveBeenCalledTimes(2)
  for (const worktreePath of ['/first', '/second']) {
    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath, relativePath: 'notes.md' })
    )
  }
  handler.dispose()
})

it('limits overflow reloads and tombstone clearing to files under the affected directory', () => {
  state.openFiles[1].externalMutation = 'deleted'
  expect(collectOverflowEditorExternalReloadTargets(target('/first'))).toEqual([
    expect.objectContaining({ worktreePath: '/first', relativePath: 'notes.md' })
  ])
  expect(state.setExternalMutation).not.toHaveBeenCalled()
})

it('protects a dirty draft when an unknown-entry overflow loses path precision', () => {
  state.openFiles = [file('/first/notes.md', true), file('/second/notes.md', true)]
  const handler = buildEditorExternalWatchEventHandler((root) => target(root))
  handler.handleFsChanged({
    worktreePath: '/first',
    shallow: true,
    events: [{ kind: 'overflow', absolutePath: '/first' }]
  })
  vi.advanceTimersByTime(100)
  expect(state.setExternalMutation).toHaveBeenCalledExactlyOnceWith('/first/notes.md', 'changed')
  expect(notifyEditorExternalFileChange).not.toHaveBeenCalled()
  expect(state.openFiles.every((entry) => entry.isDirty)).toBe(true)
  handler.dispose()
})

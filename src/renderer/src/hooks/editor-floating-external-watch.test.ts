// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type * as Autosave from '@/components/editor/editor-autosave'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  buildEditorExternalWatchEventHandler,
  collectOverflowEditorExternalReloadTargets
} from './editor-external-watch-event-reconciliation'
import { notifyEditorExternalFileChange } from '@/components/editor/editor-autosave'

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

function note(
  filePath: string,
  isDirty = false,
  worktreeId = FLOATING_TERMINAL_WORKTREE_ID
): OpenFile {
  return {
    id: `${worktreeId}:${filePath}`,
    filePath,
    relativePath: 'notes.md',
    worktreeId,
    language: 'markdown',
    mode: 'edit',
    isDirty,
    runtimeEnvironmentId: null
  }
}

const floatingTarget = {
  worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
  worktreePath: '/notes',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

describe('floating note external changes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    state.openFiles = []
  })
  afterEach(() => vi.useRealTimers())

  it('reloads an atomic replacement without leaving a deleted marker', () => {
    state.openFiles = [note('/notes/notes.md')]
    const handler = buildEditorExternalWatchEventHandler(() => floatingTarget)
    for (const kind of ['delete', 'create'] as const) {
      handler.handleFsChanged({
        worktreePath: '/notes',
        events: [{ kind, absolutePath: '/notes/notes.md', isDirectory: false }]
      })
    }
    vi.advanceTimersByTime(100)
    expect(state.setExternalMutation).not.toHaveBeenCalled()
    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        worktreePath: '/notes',
        relativePath: 'notes.md'
      })
    )
    handler.dispose()
  })

  it('keeps unsaved edits and marks a conflict instead of reloading', () => {
    const dirty = note('/notes/notes.md', true)
    state.openFiles = [dirty]
    const handler = buildEditorExternalWatchEventHandler(() => floatingTarget)
    handler.handleFsChanged({
      worktreePath: '/notes',
      events: [{ kind: 'update', absolutePath: dirty.filePath, isDirectory: false }]
    })
    vi.advanceTimersByTime(100)
    expect(state.setExternalMutation).toHaveBeenCalledWith(dirty.id, 'changed')
    expect(notifyEditorExternalFileChange).not.toHaveBeenCalled()
    handler.dispose()
  })

  it('notifies both a project tab and a floating tab sharing the same watch root', () => {
    state.openFiles = [note('/notes/notes.md'), note('/notes/notes.md', false, 'project')]
    const handler = buildEditorExternalWatchEventHandler(() => [
      floatingTarget,
      { ...floatingTarget, worktreeId: 'project' }
    ])
    handler.handleFsChanged({
      worktreePath: '/notes',
      events: [{ kind: 'update', absolutePath: '/notes/notes.md', isDirectory: false }]
    })
    vi.advanceTimersByTime(100)
    expect(notifyEditorExternalFileChange).toHaveBeenCalledTimes(2)
    for (const worktreeId of [FLOATING_TERMINAL_WORKTREE_ID, 'project']) {
      expect(notifyEditorExternalFileChange).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId })
      )
    }
    handler.dispose()
  })

  it('reloads a clean project mirror while preserving the dirty floating draft', () => {
    const dirty = note('/notes/notes.md', true)
    state.openFiles = [dirty, note('/notes/notes.md', false, 'project')]
    const handler = buildEditorExternalWatchEventHandler(() => [
      floatingTarget,
      { ...floatingTarget, worktreeId: 'project' }
    ])
    handler.handleFsChanged({
      worktreePath: '/notes',
      events: [{ kind: 'update', absolutePath: '/notes/notes.md', isDirectory: false }]
    })
    vi.advanceTimersByTime(100)
    expect(state.setExternalMutation).toHaveBeenCalledWith(dirty.id, 'changed')
    expect(notifyEditorExternalFileChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ worktreeId: 'project' })
    )
    handler.dispose()
  })

  it('forwards connection identity for updates, deletes and overflow recovery', () => {
    const findTargets = vi.fn(() => undefined)
    const handler = buildEditorExternalWatchEventHandler(findTargets)
    for (const kind of ['update', 'delete', 'overflow'] as const) {
      handler.handleFsChanged({
        connectionId: 'ssh-a',
        worktreePath: '/notes',
        events: [{ kind, absolutePath: '/notes/notes.md' }]
      })
      expect(findTargets).toHaveBeenLastCalledWith('/notes', null, 'ssh-a')
    }
    handler.dispose()
  })

  it('limits overflow reloads to floating notes inside the affected root', () => {
    state.openFiles = [
      note('/notes/notes.md'),
      note('/other/notes.md'),
      note('/notes/dirty.md', true)
    ]
    expect(collectOverflowEditorExternalReloadTargets(floatingTarget)).toEqual([
      {
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        worktreePath: '/notes',
        relativePath: 'notes.md',
        runtimeEnvironmentId: null
      }
    ])
  })

  it('does not collapse simultaneous updates to same-named notes in different folders', () => {
    state.openFiles = [note('/notes/notes.md'), note('/other/notes.md')]
    const handler = buildEditorExternalWatchEventHandler((worktreePath) => ({
      ...floatingTarget,
      worktreePath
    }))
    for (const worktreePath of ['/notes', '/other']) {
      handler.handleFsChanged({
        worktreePath,
        events: [{ kind: 'update', absolutePath: `${worktreePath}/notes.md`, isDirectory: false }]
      })
    }
    vi.advanceTimersByTime(100)
    expect(notifyEditorExternalFileChange).toHaveBeenCalledTimes(2)
    for (const worktreePath of ['/notes', '/other']) {
      expect(notifyEditorExternalFileChange).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath })
      )
    }
    handler.dispose()
  })
})

// @vitest-environment happy-dom
// Use real record middleware and save queues for cross-workspace restored drafts, phone writes, rich text and autosave pauses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'

import { requestEditorFileSave } from '../../autosave/editor-autosave'
import { attachEditorAutosaveController } from '../../autosave/editor-autosave-controller'
import { createEditorStore } from '../../autosave/editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from '../../external-changes/editor-self-write-registry'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import { GUARDED_PATH, stubGuardedDisk } from '../../save/queue/editor-save-guarded-disk-fixture'

import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

import { registerPendingEditorFlush } from '../../save/flush/editor-pending-flush'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store/index', () => {
  const getState = () => storeRef.current!.getState()
  return {
    useAppStore: Object.assign((select: (state: AppState) => unknown) => select(getState()), {
      getState
    })
  }
})
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))

const BASE = 'base'

function twoWorkspaceStore(): StoreApi<AppState> {
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
  return store
}

const view = (store: StoreApi<AppState>, id: string) =>
  store.getState().openFiles.find((tab) => tab.id === id)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __clearSelfWriteRegistryForTests()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

function openShared(disk: string) {
  const store = twoWorkspaceStore()
  for (const worktreeId of ['wt-1', 'wt-2']) {
    store.getState().openFile({
      filePath: GUARDED_PATH,
      relativePath: 'file.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
  }
  const [a, b] = store.getState().openFiles
  store.getState().setLastKnownDiskSignature(a.id, getDiskBaselineSignature(disk))
  return { store, a, b }
}

describe('two workspaces on one record', () => {
  it("a save writes another view's pending rich text; typing during the save stays dirty (scenario 5)", async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const { store, a, b } = openShared(BASE)
    store.getState().setEditorDraft(a.id, 'source')
    store.getState().markFileDirty(a.id, true)
    let pending: string | null = 'source, rich'
    const unregister = registerPendingEditorFlush(b.id, () => {
      if (pending !== null) {
        store.getState().setEditorDraft(b.id, pending)
        pending = null
      }
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: a.id })
      expect(disk.files.get(GUARDED_PATH)).toBe('source, rich')
      expect(view(store, b.id)?.isDirty).toBe(false)
    } finally {
      unregister()
      cleanup()
    }
  })
})

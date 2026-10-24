import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'
import { indexEditorExternalWatchBatchPaths } from '@/components/editor/editor-external-watch-path-index'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

// Why: the catalog says workspace wt-b (root /b) holds /b/report.md.
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: (_state: unknown, _hostId: string, absolutePath: string) =>
    absolutePath === '/b/report.md'
      ? { worktreeId: 'wt-b', relativePath: 'report.md', executionHostId: 'local' }
      : null
}))

const setExternalMutation = vi.fn()
const ownerTarget = {
  worktreeId: 'wt-b',
  worktreePath: '/b',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

/** A read-only view in workspace A of B's file, as a session restore draws it: nothing extra stored. */
function restoredView(extra: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'view',
    worktreeId: 'wt-a',
    filePath: '/b/report.md',
    relativePath: '/b/report.md',
    language: 'markdown',
    mode: 'edit',
    isDirty: false,
    readOnly: true,
    ...extra
  }
}

function useOpenFiles(openFiles: OpenFile[]): void {
  vi.mocked(useAppStore.getState).mockReturnValue({
    ...createTestStore().getState(),
    openFiles,
    setExternalMutation
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a read-only view of another workspace's file", () => {
  it('matches the owning workspace watch after a restore', () => {
    const view = restoredView()
    useOpenFiles([view])
    const index = indexEditorExternalWatchBatchPaths(
      { worktreePath: '/b', events: [{ kind: 'update', absolutePath: '/b/report.md' }] },
      [view],
      { ...ownerTarget, catalog: useAppStore.getState() }
    )

    expect(index.matchingOpenFiles(index.changes[0])).toEqual([view])
  })

  it('clears its deleted mark when the owner recreates the file', () => {
    useOpenFiles([restoredView({ externalMutation: 'deleted' })])
    const { handleFsChanged, dispose } = buildEditorExternalWatchEventHandler((path) =>
      path === '/b' ? ownerTarget : undefined
    )

    handleFsChanged({
      worktreePath: '/b',
      events: [{ kind: 'create', absolutePath: '/b/report.md' }]
    })

    expect(setExternalMutation).toHaveBeenCalledWith('view', null)
    dispose()
  })

  it('is marked deleted when the owner deletes the file', () => {
    useOpenFiles([restoredView()])
    const { handleFsChanged, dispose } = buildEditorExternalWatchEventHandler((path) =>
      path === '/b' ? ownerTarget : undefined
    )

    handleFsChanged({
      worktreePath: '/b',
      events: [{ kind: 'delete', absolutePath: '/b/report.md' }]
    })
    vi.runAllTimers()

    expect(setExternalMutation).toHaveBeenCalledWith('view', 'deleted')
    dispose()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { useAppStore } from '@/store'
import {
  assertEditorBufferInvariant,
  withEditorBufferRecords
} from './editor-buffer-record-lifecycle'
import {
  adoptMirroredEditorBuffers,
  type EditorBufferRecords
} from './slices/editor/buffers/editor-buffer-record'
import type { OpenFile } from './slices/editor/types/open-file'
import {
  EMPTY_EDITOR_BUFFER_VIEW_INDEX,
  type EditorBufferViewIndex
} from './slices/editor/buffers/editor-buffer-views'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { drawTabsFromMain } from './slices/tabs-drawn-from-main.test-fixture'

// Switch on: main renames the tabs, and its frame rekeys the content (T1 transport, apply mode).
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

function openEditTab(filePath = '/repo/a.md', worktreeId = 'wt-1'): string {
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath.slice('/repo/'.length),
      worktreeId,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

function fileOf(id: string): OpenFile | undefined {
  return useAppStore.getState().openFiles.find((file) => file.id === id)
}

/** Fails the test if any notification ever exposes a mirror without its record. */
function watchInvariant(): { notifications: () => number; stop: () => void } {
  let notifications = 0
  const stop = useAppStore.subscribe((state) => {
    notifications += 1
    assertEditorBufferInvariant(state)
  })
  return { notifications: () => notifications, stop }
}

describe('editor buffer records', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('creates a record when a tab opens and deletes it when the tab closes', () => {
    const id = openEditTab()
    expect(useAppStore.getState().editorBuffers[id]).toEqual({
      isDirty: false,
      lastKnownDiskSignature: undefined,
      externalMutation: undefined,
      pendingOwnerMigration: undefined
    })

    useAppStore.getState().closeFile(id)

    expect(useAppStore.getState().editorBuffers).toEqual({})
  })

  it.each([
    [
      'markFileDirty',
      (id: string) => useAppStore.getState().markFileDirty(id, true),
      'isDirty',
      true
    ],
    [
      'setExternalMutation',
      (id: string) => useAppStore.getState().setExternalMutation(id, 'changed'),
      'externalMutation',
      'changed'
    ],
    [
      'setLastKnownDiskSignature',
      (id: string) => useAppStore.getState().setLastKnownDiskSignature(id, 'sig-1'),
      'lastKnownDiskSignature',
      'sig-1'
    ],
    [
      'setRestoredEditorOwnerMigrationPending',
      (id: string) => useAppStore.getState().setRestoredEditorOwnerMigrationPending(id, true),
      'pendingOwnerMigration',
      true
    ]
  ] as const)('%s writes the record and its mirror in one update', (_name, write, field, value) => {
    const id = openEditTab()
    const watch = watchInvariant()

    write(id)

    watch.stop()
    expect(watch.notifications()).toBe(1)
    expect(useAppStore.getState().editorBuffers[id]?.[field]).toBe(value)
    expect(fileOf(id)?.[field]).toBe(value)
  })

  it('re-keys the record with a self-move', async () => {
    const main = await drawTabsFromMain(useAppStore)
    const id = openEditTab()
    await main.settle()
    useAppStore.getState().markFileDirty(id, true)
    useAppStore.getState().setLastKnownDiskSignature(id, 'sig-a')
    const watch = watchInvariant()

    const result = useAppStore.getState().rekeyOpenFilesForPathChange({
      rekeys: [
        {
          oldFileId: id,
          newFileId: '/repo/b.md',
          oldFilePath: '/repo/a.md',
          newFilePath: '/repo/b.md',
          newRelativePath: 'b.md'
        }
      ],
      moveOperationId: 'move-1'
    })
    await main.settle()
    main.close()

    watch.stop()
    expect(result).toEqual({ ok: true })
    const records = useAppStore.getState().editorBuffers
    expect(Object.keys(records)).toEqual(['/repo/b.md'])
    expect(records['/repo/b.md']).toMatchObject({
      isDirty: true,
      lastKnownDiskSignature: 'sig-a'
    })
  })

  it('creates hydrated records from the session, not from a replaced same-id tab', () => {
    const workspace = folderWorkspaceKey('ws')
    const id = openEditTab('/repo/a.md', workspace)

    useAppStore.getState().hydrateEditorSession(
      {
        activeRepoId: null,
        activeWorktreeId: workspace,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        openFilesByWorktree: {
          [workspace]: [
            {
              filePath: '/repo/a.md',
              relativePath: 'a.md',
              worktreeId: workspace,
              language: 'markdown',
              dirtyDraftContent: 'draft',
              lastKnownDiskSignature: 'sig-saved'
            }
          ]
        }
      },
      { additionalValidWorkspaceKeys: [workspace] }
    )

    expect(useAppStore.getState().editorBuffers[id]).toMatchObject({
      isDirty: true,
      lastKnownDiskSignature: 'sig-saved'
    })
  })

  it('seeds a record for an externally written tab from the tab, never from defaults', () => {
    useAppStore.setState({
      openFiles: [
        {
          id: 'seeded',
          filePath: '/repo/seeded.md',
          relativePath: 'seeded.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          mode: 'edit',
          isDirty: true,
          externalMutation: 'changed'
        }
      ]
    })

    expect(useAppStore.getState().editorBuffers.seeded).toMatchObject({
      isDirty: true,
      externalMutation: 'changed'
    })
  })

  it("adopts a host republish of a mirrored tab's buffer state, as remote session sync writes it", () => {
    const id = openEditTab()
    const republish = (mirroredFromRuntimeSession: true | undefined): void =>
      useAppStore.setState((state) => {
        const openFiles = state.openFiles.map((file) =>
          file.id === id ? { ...file, isDirty: !file.isDirty, mirroredFromRuntimeSession } : file
        )
        return {
          openFiles,
          editorBuffers: adoptMirroredEditorBuffers(state.editorBuffers, openFiles, state)
        }
      })

    // Why: only host-owned tabs adopt; a local tab's buffer state is written through its record.
    expect(() => republish(undefined)).toThrow(/"isDirty" of/)
    republish(true)

    expect(useAppStore.getState().editorBuffers[id]?.isDirty).toBe(true)
    expect(fileOf(id)?.isDirty).toBe(true)
  })

  it('rejects a slice write that changes a mirror field without its record', () => {
    type State = EditorBufferViewIndex & {
      openFiles: OpenFile[]
      editorBuffers: EditorBufferRecords
      dirtyMirrorOnly: () => void
    }
    const store = create<State>()(
      withEditorBufferRecords((set) => ({
        openFiles: [
          {
            id: 'a',
            filePath: '/a',
            relativePath: 'a',
            worktreeId: 'wt',
            language: 'text',
            mode: 'edit',
            isDirty: false
          }
        ],
        editorBuffers: {},
        ...EMPTY_EDITOR_BUFFER_VIEW_INDEX,
        dirtyMirrorOnly: () =>
          set((s) => ({
            openFiles: s.openFiles.map((file) => ({ ...file, isDirty: true }))
          }))
      }))
    )
    store.setState({ openFiles: [...store.getState().openFiles] })

    expect(() => store.getState().dirtyMirrorOnly()).toThrow(/"isDirty" of a/)
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
  })
})

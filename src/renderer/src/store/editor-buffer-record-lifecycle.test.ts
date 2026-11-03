import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'zustand'
import { useAppStore } from '@/store'
import { assertEditorBufferInvariant } from './editor-buffer-record-lifecycle'
import './slices/editor/buffers/editor-buffer-record'

import './slices/editor/buffers/editor-buffer-views'
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
})

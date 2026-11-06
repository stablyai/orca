import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'zustand'
import { useAppStore } from '@/store/index'
import './slices/editor/buffers/editor-buffer-record'

import './slices/editor/buffers/editor-buffer-views'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

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

describe('editor buffer records', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
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

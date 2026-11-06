import type { RuntimeMobileSessionMarkdownTab } from '../../../shared/runtime-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'node:path'

import type { OpenFile } from '../store/slices/editor'
import { buildOwnedEditorFileId } from '../store/slices/editor/file-ids/editor-file-ids'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import './web-session-focus-intent'

import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

// Why: a server's file is named by its owned id from the first open, as restore names it.
const README_ID = buildOwnedEditorFileId('/repo/README.md', WT, ENV)

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot host-invariant editor dedup', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  const variant = (id: string, isActive: boolean): RuntimeMobileSessionMarkdownTab => ({
    type: 'markdown',
    id,
    title: 'README.md',
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    language: 'markdown',
    mode: 'edit',
    isDirty: false,
    isActive,
    sourceFileId: README_ID,
    sourceFilePath: '/repo/README.md',
    sourceRelativePath: 'README.md',
    documentVersion: 'file:/repo/README.md'
  })
  const envVariantId = (env: string) => buildOwnedEditorFileId('/repo/README.md', WT, env)

  function stateWithVariant(id: string, retained: OpenFile): WebSessionTabsSyncState {
    return makeState({
      activeFileId: retained.id,
      activeFileIdByWorktree: { [WT]: retained.id },
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' },
      activeGroupIdByWorktree: { [WT]: 'host-group-1' },
      openFiles: [retained],
      editorDrafts: { [retained.id]: '# unsaved client edit' },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id,
            entityId: retained.id,
            worktreeId: WT,
            groupId: 'host-group-1',
            contentType: 'editor',
            label: 'README.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW - 1,
            isPreview: false
          }
        ]
      },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'host-group-1',
            worktreeId: WT,
            activeTabId: id,
            tabOrder: [id],
            recentTabIds: [id]
          }
        ]
      }
    })
  }

  const ownedFile: OpenFile = {
    id: README_ID,
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    worktreeId: WT,
    language: 'markdown',
    mode: 'edit',
    isDirty: true,
    runtimeEnvironmentId: ENV,
    mirroredFromRuntimeSession: true
  }

  it('retains a pending relay draft identity even when navigation selects another variant', () => {
    const retained: OpenFile = {
      ...ownedFile,
      id: '/repo/README.md',
      runtimeEnvironmentId: null,
      pendingOwnerMigration: true
    }
    const state = stateWithVariant(envVariantId('env-b'), retained)
    const selectedId = envVariantId('env-a')
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([variant(selectedId, true), variant(envVariantId('env-b'), false)], {
        activeTabId: selectedId,
        activeTabType: 'markdown',
        navigationIntent: 'follow'
      }),
      ENV,
      NOW
    )

    expect(patch.openFiles ?? state.openFiles).toEqual([retained])
    expect((patch.openFiles ?? state.openFiles)[0]).toBe(retained)
    expect(patch.unifiedTabsByWorktree?.[WT]).toMatchObject([
      { id: selectedId, entityId: retained.id }
    ])
    expect(patch.unifiedTabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.editorDrafts ?? state.editorDrafts).toEqual(state.editorDrafts)
  })

  it.each([
    { filePath: '/workspace/notes/Read me #1%.md', worktree: 'folder:/workspace' },
    { filePath: 'C:\\workspace\\docs\\Read me.md', worktree: 'folder:C:\\workspace' },
    { filePath: '\\\\server\\share\\Read me.md', worktree: 'folder:\\\\server\\share' }
  ])('collapses encoded variants for the host path $filePath', ({ filePath, worktree }) => {
    const tabs = ['host:a', 'host:b'].map((environment) => ({
      ...variant(buildOwnedEditorFileId(filePath, worktree, environment), false),
      filePath,
      sourceFilePath: filePath
    }))
    const state = makeState({ activeWorktreeId: worktree })
    const snapshot = makeSnapshot(tabs, { worktree, activeTabId: null, activeTabType: null })
    const patch = applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
    const nextState = { ...state, ...patch }
    const replay = applyWebSessionTabsSnapshot(nextState, snapshot, ENV, NOW + 1)

    expect(patch.openFiles).toMatchObject([{ filePath, worktreeId: worktree }])
    expect(patch.openFiles).toHaveLength(1)
    expect(patch.unifiedTabsByWorktree?.[worktree]).toHaveLength(1)
    expect((replay.openFiles ?? nextState.openFiles)[0]?.id).toBe(patch.openFiles?.[0]?.id)
    expect(
      (replay.unifiedTabsByWorktree ?? nextState.unifiedTabsByWorktree)[worktree]
    ).toHaveLength(1)
  })
})

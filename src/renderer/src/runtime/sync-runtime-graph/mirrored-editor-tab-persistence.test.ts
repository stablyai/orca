import { beforeEach, expect, it, vi } from 'vitest'
import { parseWorkspaceSessionSalvaging } from '../../../../shared/workspace-session-salvage'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../../shared/runtime-types'
import { buildEditorSessionData } from '../../lib/workspace-session'
import { buildHydratedEditorSessionState } from '../../store/slices/editor/actions/hydrated-editor-session-state'
import { createTestStore, makeWorktree } from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import { applyWebSessionTabsSnapshot } from '../web-session-tabs-sync/snapshot-api'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))
createStoreSessionMockApi()
beforeEach(resetWebSessionTabsSyncTestState)

it('does not republish a mirrored editor after persistence and hydration', () => {
  const snapshot = makeSnapshot([
    {
      type: 'file',
      id: 'host-file-tab',
      title: 'app.ts',
      filePath: '/repo/app.ts',
      relativePath: 'app.ts',
      language: 'typescript',
      mode: 'edit',
      isDirty: false,
      isActive: true
    }
  ])
  const state = makeState()
  const applied = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW) }
  const persisted = buildEditorSessionData(applied.openFiles, {}, {}, {}, {})
  const restored = createTestStore()
  restored.setState({
    repos: [{ id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }],
    worktreesByRepo: { repo: [makeWorktree({ id: WT, repoId: 'repo', path: '/worktree' })] },
    activeWorktreeId: WT
  })
  const loaded = parseWorkspaceSessionSalvaging({
    activeRepoId: 'repo',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...persisted
  })
  if (!loaded.ok) {
    throw new Error(loaded.error)
  }
  expect(loaded.droppedCount).toBe(0)
  expect(loaded.value.openFilesByWorktree?.[WT]?.[0]).toHaveProperty(
    'mirroredFromRuntimeSession',
    true
  )
  restored.getState().hydrateEditorSession(loaded.value)

  expect(restored.getState().openFiles).toHaveLength(1)
  expect(restored.getState().openFiles[0]?.id).not.toBe('/repo/app.ts')
  expect(buildMobileSessionTabSnapshots(restored.getState(), false).flatMap((s) => s.tabs)).toEqual(
    []
  )
  expect(persisted.openFilesByWorktree?.[WT]?.[0]).toHaveProperty(
    'mirroredFromRuntimeSession',
    true
  )
  expect(restored.getState().openFiles[0]).toHaveProperty('mirroredFromRuntimeSession', true)

  restored.setState(applyWebSessionTabsSnapshot(restored.getState(), snapshot, ENV, NOW + 1))
  expect(buildMobileSessionTabSnapshots(restored.getState(), false).flatMap((s) => s.tabs)).toEqual(
    []
  )

  for (const flag of [false, undefined]) {
    const local = buildEditorSessionData(
      applied.openFiles.map((file) => ({ ...file, mirroredFromRuntimeSession: flag })),
      {},
      {},
      {},
      {}
    )
    expect(local.openFilesByWorktree?.[WT]?.[0]).not.toHaveProperty('mirroredFromRuntimeSession')
  }
})

it('keeps a restored dirty mirror until the host publishes the worktree', () => {
  const persisted = buildEditorSessionData(
    [
      {
        id: 'host-file',
        filePath: '/repo/app.ts',
        relativePath: 'app.ts',
        worktreeId: WT,
        language: 'typescript',
        mode: 'edit',
        isDirty: true,
        runtimeEnvironmentId: ENV,
        mirroredFromRuntimeSession: true
      }
    ],
    { 'host-file': 'unsaved client edits' },
    {},
    {},
    {}
  )
  const restored = buildHydratedEditorSessionState(
    {
      activeRepoId: 'repo',
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...persisted
    },
    new Set([WT]),
    WT
  ).state
  const state = makeState(restored)
  const unpublished = makeSnapshot([], {
    publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
    snapshotVersion: 0
  })
  const held = { ...state, ...applyWebSessionTabsSnapshot(state, unpublished, ENV, NOW) }
  expect(
    buildEditorSessionData(held.openFiles, held.editorDrafts ?? {}, {}, {}, {})
      .openFilesByWorktree?.[WT]?.[0]?.dirtyDraftContent
  ).toBe('unsaved client edits')

  const closed = {
    ...held,
    ...applyWebSessionTabsSnapshot(held, makeSnapshot([]), ENV, NOW + 1)
  }
  expect(closed.openFiles).toEqual([])
})

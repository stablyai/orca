import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeState as makePublicationState } from '../sync-runtime-graph-test-harness'
import { applyWebSessionTabsSnapshot } from '../web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'
import { getRuntimeMobileSessionSyncKey, runtimeMobileSessionSyncKeysEqual } from './sync-key'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab
} from '../../../../shared/runtime-types'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))

describe('mirrored editor tab republication', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  function mirrorHostTab(tab: RuntimeMobileSessionFileTab | RuntimeMobileSessionMarkdownTab) {
    const state = makeState()
    const patch = applyWebSessionTabsSnapshot(state, makeSnapshot([tab]), ENV, NOW)
    return makePublicationState({ ...state, ...patch })
  }

  const fileTab: RuntimeMobileSessionFileTab = {
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

  it('does not republish a file mirrored from a host snapshot and caches the empty snapshot', () => {
    const clientState = mirrorHostTab(fileTab)
    expect(clientState.openFiles).toMatchObject([
      { worktreeId: WT, runtimeEnvironmentId: ENV, mirroredFromRuntimeSession: true }
    ])
    expect(clientState.unifiedTabsByWorktree[WT]).toMatchObject([
      { id: 'host-file-tab', contentType: 'editor' }
    ])
    const snapshots = buildMobileSessionTabSnapshots(clientState, false)
    expect(snapshots).toMatchObject([{ worktree: WT, tabs: [] }])
    expect(buildMobileSessionTabSnapshots(clientState, false)[0]).toBe(snapshots[0])
  })

  it.each(['edit', 'markdown-preview'] as const)(
    'does not republish mirrored markdown in %s mode',
    (mode) => {
      const clientState = mirrorHostTab({
        ...fileTab,
        type: 'markdown',
        language: 'markdown',
        mode,
        sourceFileId: '/repo/app.ts',
        sourceFilePath: '/repo/app.ts',
        sourceRelativePath: 'app.ts',
        documentVersion: 'file:/repo/app.ts'
      })
      expect(clientState.openFiles[0]?.mirroredFromRuntimeSession).toBe(true)
      expect(buildMobileSessionTabSnapshots(clientState, false)).toMatchObject([
        { worktree: WT, tabs: [] }
      ])
    }
  )

  it('keeps a genuinely local file in the same worktree and retracts it after close', () => {
    const mirroredState = mirrorHostTab(fileTab)
    const clientState = {
      ...mirroredState,
      openFiles: [
        ...mirroredState.openFiles,
        {
          id: 'local-file',
          filePath: '/repo/local.ts',
          relativePath: 'local.ts',
          worktreeId: WT,
          language: 'typescript',
          mode: 'edit' as const,
          isDirty: false
        }
      ]
    }
    const snapshots = buildMobileSessionTabSnapshots(clientState, false)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.tabs).toMatchObject([
      { type: 'file', id: 'local-file', filePath: '/repo/local.ts' }
    ])
    expect(snapshots[0]?.tabGroups?.flatMap((group) => group.tabOrder)).not.toContain(
      'host-file-tab'
    )
    expect(buildMobileSessionTabSnapshots(mirroredState, false)).toMatchObject([
      { worktree: WT, tabs: [] }
    ])
    expect(buildMobileSessionTabSnapshots(clientState, false)[0]?.snapshotVersion).toBeGreaterThan(
      snapshots[0]!.snapshotVersion
    )
  })

  it('filters mirrors without unified tabs or groups', () => {
    const clientState = mirrorHostTab(fileTab)
    expect(
      buildMobileSessionTabSnapshots(
        makePublicationState({ openFiles: clientState.openFiles }),
        false
      )
    ).toMatchObject([{ worktree: WT, tabs: [] }])
  })

  it('resyncs when only the mirror ownership flag changes', () => {
    const mirroredState = mirrorHostTab(fileTab)
    const ownedState = {
      ...mirroredState,
      openFiles: mirroredState.openFiles.map((file) => ({
        ...file,
        mirroredFromRuntimeSession: false
      }))
    }
    const ownedKey = getRuntimeMobileSessionSyncKey(ownedState, undefined, undefined, false)
    const mirroredKey = getRuntimeMobileSessionSyncKey(mirroredState, ownedState, ownedKey, false)
    expect(runtimeMobileSessionSyncKeysEqual(ownedKey, mirroredKey)).toBe(false)
    expect(buildMobileSessionTabSnapshots(ownedState, false)[0]?.tabs).toMatchObject([
      { type: 'file', id: 'host-file-tab' }
    ])
    expect(buildMobileSessionTabSnapshots(mirroredState, false)).toMatchObject([
      { worktree: WT, tabs: [] }
    ])
  })

  it('keeps workspace membership when a mirrored terminal remains after the file closes', () => {
    const terminal = {
      type: 'terminal' as const,
      id: HOST_SURFACE_ID,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      title: 'host shell',
      isActive: false,
      status: 'ready' as const,
      terminal: 'terminal-1'
    }
    const state = makeState()
    const withFile = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, makeSnapshot([terminal, fileTab]), ENV, NOW)
    }
    const before = buildMobileSessionTabSnapshots(makePublicationState(withFile), false)
    const withoutFile = {
      ...withFile,
      ...applyWebSessionTabsSnapshot(
        withFile,
        makeSnapshot([terminal], { snapshotVersion: 2 }),
        ENV,
        NOW + 1
      )
    }
    expect(withoutFile.openFiles).toEqual([])
    expect(withoutFile.tabsByWorktree[WT]).toHaveLength(1)
    const afterState = makePublicationState(withoutFile)
    const after = buildMobileSessionTabSnapshots(afterState, false)
    expect(before).toMatchObject([{ worktree: WT, tabs: [] }])
    expect(after).toMatchObject([{ worktree: WT, tabs: [] }])
    expect(buildMobileSessionTabSnapshots(afterState, false)[0]).toBe(after[0])
  })

  it('characterizes first-wins publication when an old peer echoes a locally open file', () => {
    const localFile = {
      id: '/repo/app.ts',
      filePath: '/repo/app.ts',
      relativePath: 'app.ts',
      worktreeId: WT,
      language: 'typescript',
      mode: 'edit' as const,
      isDirty: false
    }
    const state = makeState({
      openFiles: [localFile],
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: 'a-own-tab',
            entityId: localFile.id,
            groupId: 'local-group',
            worktreeId: WT,
            contentType: 'editor',
            label: 'app.ts',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW,
            isPreview: false,
            isPinned: false
          }
        ]
      }
    })
    const applied = {
      ...state,
      ...applyWebSessionTabsSnapshot(
        state,
        makeSnapshot([{ ...fileTab, id: 'peer-file-tab' }]),
        ENV,
        NOW
      )
    }
    expect(applied.openFiles).toHaveLength(2)
    expect(applied.openFiles[0]).toBe(localFile)
    expect(applied.openFiles[1]).toMatchObject({
      id: localFile.id,
      runtimeEnvironmentId: ENV,
      mirroredFromRuntimeSession: true
    })
    expect(applied.unifiedTabsByWorktree[WT]).toMatchObject([
      { id: 'peer-file-tab', entityId: localFile.id }
    ])
    expect(
      buildMobileSessionTabSnapshots(makePublicationState(applied), false)[0]?.tabs
    ).toMatchObject([{ id: 'peer-file-tab', type: 'file', filePath: localFile.filePath }])
    const closed = {
      ...applied,
      ...applyWebSessionTabsSnapshot(
        applied,
        makeSnapshot([], { snapshotVersion: 2 }),
        ENV,
        NOW + 1
      )
    }
    expect(closed.openFiles).toEqual([localFile])
    expect(closed.unifiedTabsByWorktree[WT]).toBeUndefined()
  })
})

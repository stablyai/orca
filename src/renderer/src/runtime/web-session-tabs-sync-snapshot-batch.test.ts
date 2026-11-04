import { beforeEach, describe, expect, it, vi } from 'vitest'
import { posix as pathPosix } from 'node:path'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

import type { OpenFile } from '../store/slices/editor'
import { buildOwnedEditorFileId } from '../store/slices/editor/file-ids/editor-file-ids'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots
} from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('matches sequential open-file reconciliation across an editor-heavy batch', () => {
    const secondWorktree = 'repo::/other-worktree'
    const editorSurface = (
      id: string,
      path: string,
      overrides: { isDirty?: boolean } = {}
    ): RuntimeMobileSessionTabsResult['tabs'][number] =>
      ({
        type: 'file',
        id,
        title: pathPosix.basename(path),
        filePath: path,
        relativePath: path.replace(/^\/repo\//, ''),
        language: 'typescript',
        isDirty: overrides.isDirty ?? false,
        isActive: true
      }) as RuntimeMobileSessionTabsResult['tabs'][number]
    const mirroredFile = (path: string, worktree: string): OpenFile =>
      ({
        id: path,
        filePath: path,
        relativePath: path.replace(/^\/repo\//, ''),
        worktreeId: worktree,
        language: 'typescript',
        isDirty: false,
        runtimeEnvironmentId: ENV,
        mode: 'edit',
        mirroredFromRuntimeSession: true
      }) as OpenFile
    const initial = makeState({
      activeWorktreeId: WT,
      activeFileId: '/repo/a.ts',
      activeFileIdByWorktree: { [WT]: '/repo/a.ts' },
      openFiles: [
        // Why: a bystander worktree's files must keep their positions through the batch.
        mirroredFile('/repo/bystander-1.ts', 'repo::/bystander'),
        mirroredFile('/repo/a.ts', WT),
        // Why: locally opened (not host-mirrored) files must survive a host omission.
        {
          ...mirroredFile('/repo/local-only.ts', WT),
          mirroredFromRuntimeSession: false
        } as OpenFile,
        // Same worktree/file ID, different environment exposes first-wins duplicate lookup.
        {
          ...mirroredFile('/repo/a.ts', WT),
          runtimeEnvironmentId: 'other-env'
        } as OpenFile,
        mirroredFile('/repo/dropped.ts', WT),
        mirroredFile('/repo/bystander-2.ts', 'repo::/bystander'),
        mirroredFile('/repo/second.ts', secondWorktree)
      ]
    })
    const snapshots: RuntimeMobileSessionTabsResult[] = [
      makeSnapshot([editorSurface('host-a', '/repo/a.ts', { isDirty: true })], {
        activeTabId: 'host-a',
        activeTabType: 'file'
      }),
      makeSnapshot([editorSurface('host-second', '/repo/second.ts')], {
        worktree: secondWorktree,
        activeGroupId: 'host-group-2',
        activeTabId: 'host-second',
        activeTabType: 'file'
      }),
      // Same worktree again: adds a file, so the batch must see snapshot 1's result.
      makeSnapshot(
        [
          editorSurface('host-a', '/repo/a.ts', { isDirty: true }),
          editorSurface('host-b', '/repo/b.ts')
        ],
        { snapshotVersion: 2, activeTabId: 'host-b', activeTabType: 'file' }
      ),
      makeSnapshot([], {
        worktree: secondWorktree,
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null
      })
    ]
    const initialCopy = structuredClone(initial)

    let sequential = initial
    for (const snapshot of snapshots) {
      const patch = applyWebSessionTabsSnapshot(sequential, snapshot, ENV, NOW)
      if (patch !== sequential) {
        sequential = { ...sequential, ...patch }
      }
    }

    resetWebSessionTabsSnapshotFreshnessForTests()
    const batched = {
      ...initial,
      ...applyWebSessionTabsSnapshots(initial, snapshots, ENV, NOW)
    }

    expect(batched.openFiles).toEqual(sequential.openFiles)
    expect(batched).toEqual(sequential)
    expect(initial).toEqual(initialCopy)
    // Pin the observable outcomes rather than only cross-checking the two paths.
    expect(batched.openFiles.map((file) => file.id)).toEqual([
      '/repo/bystander-1.ts',
      '/repo/local-only.ts',
      '/repo/a.ts',
      '/repo/bystander-2.ts',
      '/repo/a.ts',
      // A file the host opens now takes its owned id; a.ts keeps the id it already had.
      buildOwnedEditorFileId('/repo/b.ts', WT, ENV)
    ])
    expect(
      batched.openFiles.find(
        (file) => file.id === '/repo/a.ts' && file.runtimeEnvironmentId === 'other-env'
      )
    ).toBeDefined()
    expect(batched.openFiles.some((file) => file.id === '/repo/dropped.ts')).toBe(false)
    expect(batched.openFiles.some((file) => file.id === '/repo/second.ts')).toBe(false)
  })

  it('rebuilds an open file the batch closed and reopened, as sequential does', () => {
    // Net equality must not discard rebuilt file identity and its autosave/disk-signature state.
    const beforeBatch = {
      id: '/repo/a.ts',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: WT,
      language: 'typescript',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit',
      mirroredFromRuntimeSession: true,
      lastKnownDiskSignature: 'stale-signature'
    } as OpenFile
    const editorSnapshot = (path: string, version: number): RuntimeMobileSessionTabsResult =>
      makeSnapshot(
        [
          {
            type: 'file',
            id: `host-${path}`,
            title: path,
            filePath: path,
            relativePath: path.slice('/repo/'.length),
            language: 'typescript',
            isDirty: false,
            isActive: true
          } as RuntimeMobileSessionTabsResult['tabs'][number]
        ],
        { snapshotVersion: version, activeTabId: `host-${path}`, activeTabType: 'file' }
      )
    const snapshots = [editorSnapshot('/repo/b.ts', 1), editorSnapshot('/repo/a.ts', 2)]
    const state = makeState({ openFiles: [beforeBatch] })

    resetWebSessionTabsSnapshotFreshnessForTests()
    let sequential = state
    for (const snapshot of snapshots) {
      const patch = applyWebSessionTabsSnapshot(sequential, snapshot, ENV, NOW)
      if (patch !== sequential) {
        sequential = { ...sequential, ...patch }
      }
    }

    resetWebSessionTabsSnapshotFreshnessForTests()
    const batched = { ...state, ...applyWebSessionTabsSnapshots(state, snapshots, ENV, NOW) }

    expect(batched.openFiles).toEqual(sequential.openFiles)
    expect(batched.openFiles.map((file) => file.id)).toEqual([
      buildOwnedEditorFileId('/repo/a.ts', WT, ENV)
    ])
    expect(batched.openFiles[0]?.lastKnownDiskSignature).toBeUndefined()
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { makeOpenFile } from '../store/slices/store-test-helpers'
import { WorkspacePresentationIndex } from '../store/workspace-presentation-index'
import {
  makeState,
  makeSnapshot,
  ENV,
  NOW,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
import { applyWebSessionTabsSnapshots } from './web-session-tabs-sync/snapshot-api'
import { webSessionOpenFilesForWorktree } from './web-session-tabs-sync/state-equality-files'

afterEach(() => vi.restoreAllMocks())
it.each([
  [10, 200],
  [100, 200],
  [10, 2000]
])(
  'populates file buckets once plus affected records for %i sources and %i unrelated files',
  (members, files) => {
    resetWebSessionTabsSyncTestState()
    const original = Array.from({ length: files }, (_, id) =>
      makeOpenFile({ id: `bystander-${id}`, worktreeId: 'other::/files' })
    )
    const state = makeState({ activeWorktreeId: null, openFiles: original })
    const snapshots = Array.from({ length: members }, (_, id) =>
      makeSnapshot(
        [
          {
            type: 'file',
            id: `host-${id}`,
            title: `${id}.ts`,
            filePath: `/repo${id}/file.ts`,
            relativePath: 'file.ts',
            language: 'typescript',
            isDirty: false,
            isActive: true
          }
        ],
        {
          worktree: `repo${id}::/repo${id}`,
          activeGroupId: `g${id}`,
          activeTabId: `host-${id}`,
          activeTabType: 'file'
        }
      )
    )
    const sets = vi.spyOn(WorkspacePresentationIndex.prototype, 'set')
    const patch = applyWebSessionTabsSnapshots(state, snapshots, ENV, NOW)
    const next = { ...state, ...patch }
    expect(next.openFiles).toHaveLength(files + members)
    const populations = sets.mock.calls.reduce(
      (total, [, bucket]) => total + (Array.isArray(bucket) ? 1 : 0),
      0
    )
    expect(populations).toBe(files + members)
    expect(webSessionOpenFilesForWorktree(state, 'other::/files')).toEqual(original)
    expect(webSessionOpenFilesForWorktree(state, 'repo0::/repo0')).toEqual([])
    expect(webSessionOpenFilesForWorktree(next, 'repo0::/repo0')).toHaveLength(1)
    expect(webSessionOpenFilesForWorktree(next, 'other::/files')).toEqual(original)
  }
)

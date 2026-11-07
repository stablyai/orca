import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionFileTab } from '../../../shared/runtime-types'
import type { OpenFile } from '../store/slices/editor/types/open-file'
import { buildOwnedEditorFileId } from '../store/slices/editor/file-ids/editor-file-ids'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const filePath = '/repo/readme.txt'
const hostTab: RuntimeMobileSessionFileTab = {
  type: 'file',
  id: 'retained-tab',
  title: 'readme.txt',
  filePath,
  relativePath: 'readme.txt',
  language: 'plaintext',
  isDirty: false,
  isActive: true
}
function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: 'readme.txt',
    worktreeId: WT,
    language: 'plaintext',
    isDirty: false,
    runtimeEnvironmentId: null,
    mode: 'edit',
    ...overrides
  }
}
function snapshot(tabs = [hostTab]) {
  return makeSnapshot(tabs, { activeTabId: hostTab.id, activeTabType: 'file' })
}

describe('host editor file ownership', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('shares a pending retained file with a newly published split listed first', () => {
    const retained = file({ isDirty: true, pendingOwnerMigration: true })
    const state = makeState({
      openFiles: [retained],
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: hostTab.id,
            entityId: retained.id,
            worktreeId: WT,
            groupId: 'legacy-group',
            executionHostId: 'ssh:legacy-target',
            contentType: 'editor',
            label: 'readme.txt',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW,
            isPreview: false
          }
        ]
      }
    })
    const patch = applyWebSessionTabsSnapshot(
      state,
      snapshot([{ ...hostTab, id: 'new-split', isActive: false }, hostTab]),
      ENV,
      NOW
    )
    expect(patch.openFiles ?? state.openFiles).toEqual([retained])
    expect(patch.unifiedTabsByWorktree?.[WT]?.map((tab) => tab.entityId)).toEqual([
      retained.id,
      retained.id
    ])
  })

  it('does not borrow another host’s disk signature or overwrite its file ID', () => {
    const other = file({ runtimeEnvironmentId: 'other-host', lastKnownDiskSignature: 'other-disk' })
    const patch = applyWebSessionTabsSnapshot(
      makeState({ openFiles: [other] }),
      snapshot(),
      ENV,
      NOW
    )
    expect(patch?.openFiles).toHaveLength(2)
    expect(patch?.openFiles?.[0]).toBe(other)
    expect(patch?.openFiles?.[1]).toMatchObject({
      id: buildOwnedEditorFileId(filePath, WT, ENV),
      runtimeEnvironmentId: ENV
    })
    expect(patch?.openFiles?.[1]?.lastKnownDiskSignature).toBeUndefined()
  })
  it('keeps the mirrored editor when a newer frame from its host drops a chat that moved away', () => {
    const chat = {
      type: 'agent-session' as const,
      id: 'agent-session:moved',
      title: 'Chat',
      sessionId: 'moved',
      agent: 'codex' as const,
      isActive: false
    }
    const initial = makeState()
    const before = {
      ...initial,
      ...applyWebSessionTabsSnapshot(
        initial,
        makeSnapshot([hostTab, chat], { activeTabId: hostTab.id, activeTabType: 'file' }),
        ENV,
        NOW
      )
    }
    expect(before.unifiedTabsByWorktree[WT]?.map((tab) => tab.contentType)).toEqual([
      'editor',
      'agent-session'
    ])
    // The host's next ordinary frame filters the moved chat out by its record.
    const after = {
      ...before,
      ...applyWebSessionTabsSnapshot(
        before,
        makeSnapshot([hostTab], {
          activeTabId: hostTab.id,
          activeTabType: 'file',
          snapshotVersion: 2
        }),
        ENV,
        NOW
      )
    }
    expect(after.openFiles).toEqual(before.openFiles)
    expect(after.unifiedTabsByWorktree[WT]?.map((tab) => tab.contentType)).toEqual(['editor'])
  })
})

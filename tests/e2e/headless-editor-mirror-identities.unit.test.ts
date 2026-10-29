import { describe, expect, it, vi } from 'vitest'
import { buildHeadlessMobileSessionEditorTabs } from '../../src/main/runtime/mobile-session-editor-projection'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import { buildOwnedEditorFileId } from '../../src/renderer/src/store/slices/editor/file-ids/editor-file-ids'
import { applyWebSessionTabsSnapshot } from '../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState
} from '../../src/renderer/src/runtime/web-session-tabs-sync-test-harness'

const host = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../src/shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return host.layoutOwnerIsMain
  }
}))

describe('headless editor identity in an older desktop mirror', () => {
  it('keeps two owners when the producer represents both source identities by the path', () => {
    const filePath = '/repo/README.md'
    const owners = [null, 'other-host']
    const session: WorkspaceSessionState = {
      activeRepoId: null,
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [WT]: owners.map((owner) => ({
          filePath,
          relativePath: 'README.md',
          worktreeId: WT,
          language: 'markdown',
          runtimeEnvironmentId: owner,
          ...(owner ? { dirtyDraftContent: 'remote draft' } : {})
        }))
      },
      unifiedTabs: {
        [WT]: owners.map((owner, index) => ({
          id: buildOwnedEditorFileId(filePath, WT, owner),
          entityId: buildOwnedEditorFileId(filePath, WT, owner),
          groupId: 'host-group-1',
          worktreeId: WT,
          contentType: 'editor',
          label: 'README.md',
          customLabel: null,
          color: null,
          sortOrder: index,
          createdAt: NOW,
          isPreview: false
        }))
      }
    }
    const tabs = buildHeadlessMobileSessionEditorTabs(WT, session)
    expect(tabs).toHaveLength(2)
    expect(tabs.map((tab) => tab.id)).toEqual(
      owners.map((owner) => buildOwnedEditorFileId(filePath, WT, owner))
    )
    expect(tabs.map((tab) => tab.isDirty)).toEqual([false, true])

    host.layoutOwnerIsMain = false
    const patch = applyWebSessionTabsSnapshot(makeState(), makeSnapshot(tabs), ENV, NOW)

    expect(patch.unifiedTabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual(
      tabs.map((tab) => tab.id)
    )
  })
})

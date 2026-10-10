import { describe, expect, it } from 'vitest'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { buildWorkspaceSessionPayload, type WorkspaceSessionSnapshot } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'

const owner: WorktreeSelectionOwner = {
  worktreeId: 'repo-1::/workspace/feature',
  publisherHostId: 'runtime:paired-host',
  executionHostId: 'ssh:execution-host',
  instanceId: 'workspace-instance-1'
}

function createSnapshot(
  overrides: Partial<WorkspaceSessionSnapshot> = {}
): WorkspaceSessionSnapshot {
  return {
    activeRepoId: 'repo-1',
    activeWorkspaceKey: 'worktree:repo-1::/workspace/feature',
    activeWorktreeId: owner.worktreeId,
    activeWorkspaceExecutionHostId: owner.publisherHostId,
    activeTabId: null,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    localOnlyScrollbackByTabId: {},
    activeTabIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    workspaceDocHistory: [],
    remoteBrowserPageHandlesByPageId: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    ...overrides
  }
}

describe('workspace session selected owner persistence', () => {
  it('preserves publisher, raw execution host and instance through a full save and parse', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot({ activeWorkspaceOwner: owner }))
    const restored = parseWorkspaceSession(JSON.parse(JSON.stringify(payload)))

    expect(restored.ok).toBe(true)
    if (restored.ok) {
      expect(restored.value.activeWorkspaceOwner).toEqual(owner)
    }
  })

  it('leaves legacy selection unqualified instead of deriving an owner from its host', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.activeWorkspaceOwner).toBeUndefined()
  })

  it('writes an owner-only change without rewriting unrelated session state', () => {
    const patch = buildWorkspaceSessionPatch(createSnapshot({ activeWorkspaceOwner: owner }), [
      'activeWorkspaceOwner'
    ])

    expect(patch).toEqual({ activeWorkspaceOwner: owner })
  })

  it.each([null, undefined])(
    'clears persisted owner proof with an explicit null: %j',
    (cleared) => {
      const saved = buildWorkspaceSessionPayload(createSnapshot({ activeWorkspaceOwner: owner }))
      const patch = buildWorkspaceSessionPatch(createSnapshot({ activeWorkspaceOwner: cleared }), [
        'activeWorkspaceOwner'
      ])
      const restored = parseWorkspaceSession(JSON.parse(JSON.stringify({ ...saved, ...patch })))

      expect(patch).toEqual({ activeWorkspaceOwner: null })
      expect(restored.ok).toBe(true)
      if (restored.ok) {
        expect(restored.value.activeWorkspaceOwner).toBeNull()
      }
    }
  )

  it('keeps an unchanged owner out of unrelated patches', () => {
    const patch = buildWorkspaceSessionPatch(createSnapshot({ activeWorkspaceOwner: owner }), [
      'activeTabId'
    ])

    expect(patch).toEqual({ activeTabId: null })
  })
})

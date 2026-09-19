import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'

// Why a dedicated fixture, not the shared one in workspace-session-patch.test.ts: this covers a
// single finding (C5) and every field here is required by WorkspaceSessionSnapshot, so no
// `as WorkspaceSessionSnapshot` cast is needed.
function createSnapshot(
  overrides: Partial<WorkspaceSessionSnapshot> = {}
): WorkspaceSessionSnapshot {
  return {
    activeRepoId: 'repo-1',
    activeWorkspaceKey: null,
    activeWorktreeId: 'wt-1',
    activeTabId: 'agents-tab',
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
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
    agentCardGroupIdsByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    closedTerminalTabTombstonesByTabId: {},
    localOnlyScrollbackByTabId: {},
    ...overrides
  }
}

describe('buildWorkspaceSessionPatch agentCardGroupIdsByWorktree rebuild condition (C5)', () => {
  it('rebuilds the persisted unified-tab session data on a registry-only mutation', () => {
    const snapshot = createSnapshot({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'agents-tab',
            entityId: 'agents-tab',
            groupId: 'g-home',
            worktreeId: 'wt-1',
            contentType: 'agents',
            label: 'Agents',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'agent-1',
            entityId: 'agent-1',
            groupId: 'g-card',
            worktreeId: 'wt-1',
            contentType: 'agent-session',
            label: 'Agent 1',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      groupsByWorktree: {
        'wt-1': [
          { id: 'g-home', worktreeId: 'wt-1', activeTabId: 'agents-tab', tabOrder: ['agents-tab'] },
          { id: 'g-card', worktreeId: 'wt-1', activeTabId: 'agent-1', tabOrder: ['agent-1'] }
        ]
      },
      layoutByWorktree: { 'wt-1': { type: 'leaf', groupId: 'g-home' } },
      activeGroupIdByWorktree: { 'wt-1': 'g-home' },
      // Why: g-card is registered as a card group (off-layout, agent-only), so the projection
      // flattens agent-1 into the Agents tab's home group and drops the Agents tab and g-card.
      agentCardGroupIdsByWorktree: { 'wt-1': ['g-card'] }
    })

    // Only the registry changed: none of the previously-listed fields did.
    const patch = buildWorkspaceSessionPatch(snapshot, ['agentCardGroupIdsByWorktree'])

    const persistedTabs = patch.unifiedTabs?.['wt-1'] ?? []
    expect(persistedTabs.some((tab) => tab.contentType === 'agents')).toBe(false)
    expect(persistedTabs.some((tab) => tab.id === 'agent-1' && tab.groupId === 'g-home')).toBe(true)
  })

  it('produces an empty patch for the same registry-only mutation when no field changed at all', () => {
    // Sanity check for the fixture itself: an empty changed-fields set must never rebuild anything.
    const snapshot = createSnapshot()

    const patch = buildWorkspaceSessionPatch(snapshot, [])

    expect(patch).toEqual({})
  })
})

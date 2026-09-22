import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildWorkspaceTerminalReconnectPlan } from './workspace-terminal-reconnect-plan'

function worktree(id: string, automation: boolean, status = 'in-progress'): Worktree {
  return {
    id,
    repoId: 'repo',
    path: id.split('::')[1] ?? id,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    workspaceStatus: status,
    ...(automation
      ? {
          automationProvenance: {
            kind: 'created-by-automation',
            automationId: 'patrol',
            automationNameSnapshot: 'patrol',
            automationRunId: id,
            automationRunTitleSnapshot: id,
            createdAt: 1,
            executionTargetType: 'local',
            executionTargetId: 'local',
            projectId: 'repo'
          }
        }
      : {})
  } as Worktree
}

function tab(id: string, worktreeId: string, ptyId: string | null = null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  } as TerminalTab
}

describe('buildWorkspaceTerminalReconnectPlan startup hydration cap', () => {
  it('does not reconnect idle automation leftovers as active sessions', () => {
    const activeId = 'repo::/main'
    const liveId = 'repo::/live'
    const leftoverIds = Array.from({ length: 40 }, (_, index) => `repo::/auto-${index}`)
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      [activeId]: [tab('active-tab', activeId)],
      [liveId]: [tab('live-tab', liveId, 'pty-live')],
      ...Object.fromEntries(leftoverIds.map((id) => [id, [tab(`${id}-tab`, id)]]))
    }
    const session = {
      activeWorktreeId: activeId,
      activeWorktreeIdsOnShutdown: [activeId, liveId, ...leftoverIds],
      tabsByWorktree,
      lastVisitedAtByWorktreeId: {}
    } as WorkspaceSessionState
    const worktrees = [
      worktree(activeId, false),
      worktree(liveId, true),
      ...leftoverIds.map((id) => worktree(id, true, 'completed'))
    ]
    const plan = buildWorkspaceTerminalReconnectPlan({
      reconnectPtyIdByRetainedTabId: new Map(),
      releasedPtyIdsByTabId: new Map(),
      repos: [{ id: 'repo' } as Repo],
      session,
      validTabIds: new Set(Object.values(tabsByWorktree).flatMap((tabs) => tabs.map((t) => t.id))),
      validWorktreeIds: new Set([activeId, liveId, ...leftoverIds]),
      worktreesByRepo: { repo: worktrees }
    })

    expect(plan.pendingReconnectWorktreeIds).toEqual([activeId, liveId])
    expect(plan.pendingReconnectPtyIdByTabId).toEqual({ 'live-tab': 'pty-live' })
  })
})

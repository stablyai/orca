import { describe, expect, it } from 'vitest'
import {
  buildCmdJQuickActionContext,
  getWorkspaceScopedActionAvailability,
  resolveCmdJActiveGroupId,
  type CmdJQuickActionContext
} from './quick-action-context'
import { CMD_J_QUICK_ACTIONS } from './quick-actions'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/types'

type GroupState = Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'>

function ctx(
  overrides: Partial<
    Pick<CmdJQuickActionContext, 'activeGroupId' | 'activeWorktreeId' | 'isLoading' | 'sshStatus'>
  >
): Pick<CmdJQuickActionContext, 'activeGroupId' | 'activeWorktreeId' | 'isLoading' | 'sshStatus'> {
  return {
    activeGroupId: 'group-1',
    activeWorktreeId: 'wt-1',
    isLoading: false,
    sshStatus: null,
    ...overrides
  }
}

describe('Cmd+J quick action context', () => {
  it('resolves the snapshot group, then falls back when stale or missing', () => {
    const state: GroupState = {
      activeGroupIdByWorktree: { 'wt-1': 'focused-group' },
      groupsByWorktree: {
        'wt-1': [
          { id: 'first-group', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] },
          { id: 'focused-group', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }
        ]
      }
    }

    expect(
      resolveCmdJActiveGroupId(state, 'wt-1', {
        worktreeId: 'wt-1',
        groupId: 'focused-group'
      })
    ).toBe('focused-group')
    expect(
      resolveCmdJActiveGroupId(state, 'wt-1', {
        worktreeId: 'wt-1',
        groupId: 'closed-group'
      })
    ).toBe('first-group')
    expect(resolveCmdJActiveGroupId(state, 'wt-1', null)).toBe('focused-group')
  })

  it('applies workspace-scoped action availability gates in order', () => {
    expect(getWorkspaceScopedActionAvailability(ctx({ activeWorktreeId: null }))).toEqual({
      available: false,
      reason: 'no-active-workspace'
    })
    expect(getWorkspaceScopedActionAvailability(ctx({ isLoading: true }))).toEqual({
      available: false,
      reason: 'loading'
    })
    expect(getWorkspaceScopedActionAvailability(ctx({ sshStatus: 'disconnected' }))).toEqual({
      available: false,
      reason: 'ssh-disconnected'
    })
    expect(getWorkspaceScopedActionAvailability(ctx({ activeGroupId: null }))).toEqual({
      available: false,
      reason: 'no-active-group'
    })
    expect(getWorkspaceScopedActionAvailability(ctx({}))).toEqual({ available: true })
  })

  it('keeps workspace-agnostic actions available while loading without an active workspace', () => {
    const context = {
      ...ctx({ activeWorktreeId: null, activeGroupId: null, isLoading: true }),
      activeWorktree: null,
      runtimeMode: 'local-desktop' as const,
      openNewBrowserTab: async () => {},
      openNewMarkdownFile: async () => {},
      openNewTerminalTab: async () => {},
      openCreateWorkspace: () => {},
      openAddQuickCommand: () => {}
    } satisfies CmdJQuickActionContext

    expect(
      CMD_J_QUICK_ACTIONS.find((action) => action.id === 'new-terminal-tab')?.isAvailable(context)
    ).toEqual({ available: false, reason: 'no-active-workspace' })
    expect(
      CMD_J_QUICK_ACTIONS.find((action) => action.id === 'create-workspace')?.isAvailable(context)
    ).toEqual({ available: true })
    expect(
      CMD_J_QUICK_ACTIONS.find((action) => action.id === 'add-quick-command')?.isAvailable(context)
    ).toEqual({ available: true })
  })

  it('applies the availability matrix across curated actions', () => {
    const workspaceActions = ['new-browser-tab', 'new-markdown-file', 'new-terminal-tab']
    const workspaceAgnosticActions = ['create-workspace', 'add-quick-command']
    const actionById = new Map(CMD_J_QUICK_ACTIONS.map((action) => [action.id, action]))
    const baseContext = {
      ...ctx({}),
      activeWorktree: null,
      runtimeMode: 'local-desktop' as const,
      openNewBrowserTab: async () => {},
      openNewMarkdownFile: async () => {},
      openNewTerminalTab: async () => {},
      openCreateWorkspace: () => {},
      openAddQuickCommand: () => {}
    } satisfies CmdJQuickActionContext

    for (const actionId of workspaceActions) {
      expect(actionById.get(actionId)?.isAvailable(baseContext)).toEqual({ available: true })
      expect(
        actionById.get(actionId)?.isAvailable({ ...baseContext, runtimeMode: 'paired-web' })
      ).toEqual({ available: true })
      expect(
        actionById.get(actionId)?.isAvailable({
          ...baseContext,
          activeWorktreeId: null,
          activeGroupId: null
        })
      ).toEqual({ available: false, reason: 'no-active-workspace' })
      expect(actionById.get(actionId)?.isAvailable({ ...baseContext, isLoading: true })).toEqual({
        available: false,
        reason: 'loading'
      })
      expect(
        actionById.get(actionId)?.isAvailable({ ...baseContext, sshStatus: 'disconnected' })
      ).toEqual({ available: false, reason: 'ssh-disconnected' })
    }

    for (const actionId of workspaceAgnosticActions) {
      expect(
        actionById.get(actionId)?.isAvailable({
          ...baseContext,
          activeWorktreeId: null,
          activeGroupId: null,
          isLoading: true,
          sshStatus: 'disconnected'
        })
      ).toEqual({ available: true })
    }
  })

  it('recomputes active group from the open snapshot against fresh store state', () => {
    const worktree = {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/repo/wt',
      displayName: 'Workspace',
      branch: 'main',
      createdAt: 0
    } as Worktree
    const state = {
      activeWorktreeId: 'wt-1',
      worktreesByRepo: { 'repo-1': [worktree] },
      repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', addedAt: 0 }],
      sshConnectionStates: new Map(),
      activeGroupIdByWorktree: { 'wt-1': 'closed-group' },
      groupsByWorktree: {
        'wt-1': [{ id: 'first-group', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }]
      },
      settings: null
    } as unknown as AppState

    const context = buildCmdJQuickActionContext({
      state,
      activeGroupSnapshot: { worktreeId: 'wt-1', groupId: 'closed-group' },
      openNewBrowserTab: async () => {},
      openNewMarkdownFile: async () => {},
      openNewTerminalTab: async () => {},
      openCreateWorkspace: () => {},
      openAddQuickCommand: () => {}
    })

    expect(context.activeGroupId).toBe('first-group')
  })

  it('derives loading from fresh store state when building the run-time context', () => {
    const state = {
      activeWorktreeId: null,
      worktreesByRepo: {},
      repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', addedAt: 0 }],
      sshConnectionStates: new Map(),
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      settings: null
    } as unknown as AppState

    const context = buildCmdJQuickActionContext({
      state,
      activeGroupSnapshot: null,
      openNewBrowserTab: async () => {},
      openNewMarkdownFile: async () => {},
      openNewTerminalTab: async () => {},
      openCreateWorkspace: () => {},
      openAddQuickCommand: () => {}
    })

    expect(context.isLoading).toBe(true)
  })

  it('runtime re-check returns unavailable without invoking the action helper', async () => {
    const calls: string[] = []
    const action = CMD_J_QUICK_ACTIONS.find((entry) => entry.id === 'new-terminal-tab')
    const context = {
      ...ctx({ activeGroupId: null }),
      activeWorktree: null,
      runtimeMode: 'local-desktop' as const,
      openNewBrowserTab: async () => {},
      openNewMarkdownFile: async () => {},
      openNewTerminalTab: async (groupId: string) => {
        calls.push(groupId)
      },
      openCreateWorkspace: () => {},
      openAddQuickCommand: () => {}
    } satisfies CmdJQuickActionContext

    await expect(action?.run(context)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-active-group'
    })
    expect(calls).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import type { Tab } from '../../../../shared/tab-types'
import {
  isNativeChatSkillDiscoveryAwaitingDirectory,
  type NativeChatSkillStateInputs
} from './native-chat-skill-discovery-context'
import {
  resolveNativeChatSkillDiscoveryContext,
  resolveNativeChatSkillDiscoveryCwd
} from './use-native-chat-skills'
import { worktreeFixture } from './native-chat-workspace-test-fixtures'

describe('resolveNativeChatSkillDiscoveryCwd', () => {
  const catalog = {
    floatingWorkspacePath: null,
    folderWorkspaces: [],
    worktreesByRepo: {
      'repo-1': [worktreeFixture('repo-1::/repo/worktree', '/repo/worktree', { repoId: 'repo-1' })]
    }
  }

  it('returns the owning worktree path for a terminal tab', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd(
        {
          ...catalog,
          tabsByWorktree: {
            'repo-1::/repo/worktree': [
              {
                id: 'tab-1'
              }
            ]
          }
        },
        'tab-1'
      )
    ).toBe('/repo/worktree')
  })

  it('returns the owning worktree path for a structured session tab', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd(
        {
          ...catalog,
          tabsByWorktree: {},
          unifiedTabsByWorktree: {
            'repo-1::/repo/worktree': [{ id: 'structured-tab-1' }]
          }
        },
        'structured-tab-1'
      )
    ).toBe('/repo/worktree')
  })

  it('returns null when the tab has no known worktree owner', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd(
        { ...catalog, tabsByWorktree: {}, worktreesByRepo: {} },
        'tab-1'
      )
    ).toBeNull()
  })

  it('prefers the pane startupCwd over the worktree root', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd(
        {
          ...catalog,
          tabsByWorktree: {
            'repo-1::/repo/worktree': [
              { id: 'tab-1', startupCwd: '/repo/worktree/packages/app' },
              { id: 'tab-2' }
            ]
          }
        },
        'tab-1'
      )
    ).toBe('/repo/worktree/packages/app')
  })
})

describe('floating workspace skill discovery', () => {
  const floatingTab: Tab = {
    id: 'floating-chat-1',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    groupId: 'floating-group',
    contentType: 'agent-session',
    entityId: 'session-1',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned: false,
    agentSessionAgent: 'codex'
  }
  const floatingInputs: NativeChatSkillStateInputs = {
    activeRepoId: null,
    activeWorkspaceExecutionHostId: null,
    activeWorktreeId: null,
    detectedWorktreesByRepo: {},
    floatingWorkspacePath: '/home/me/scratch',
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    // Floating panels stay local even with a focused paired runtime.
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-1' },
    structuredSessionLaunchDirectoryByTabId: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
    worktreesByRepo: {}
  }

  it('scans nothing and awaits the pin rather than scanning the current setting', () => {
    expect(resolveNativeChatSkillDiscoveryCwd(floatingInputs, 'floating-chat-1')).toBeNull()
    expect(resolveNativeChatSkillDiscoveryContext(floatingInputs, 'floating-chat-1')).toBeNull()
    expect(isNativeChatSkillDiscoveryAwaitingDirectory(floatingInputs, 'floating-chat-1')).toBe(
      true
    )
  })

  it('scans the pinned folder after the floating setting moved', () => {
    const pinned: NativeChatSkillStateInputs = {
      ...floatingInputs,
      floatingWorkspacePath: '/home/me/changed-setting',
      structuredSessionLaunchDirectoryByTabId: {
        'floating-chat-1': { sessionId: 'session-1', launchDirectory: '/home/me/pinned' }
      }
    }
    expect(isNativeChatSkillDiscoveryAwaitingDirectory(pinned, 'floating-chat-1')).toBe(false)
    expect(resolveNativeChatSkillDiscoveryContext(pinned, 'floating-chat-1')).toMatchObject({
      cwd: '/home/me/pinned',
      executionHostKind: 'local',
      runtimeTarget: { kind: 'local' },
      discoveryTarget: { cwd: '/home/me/pinned', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
    })
  })

  it('stays not-ready until the floating directory resolves', () => {
    expect(
      resolveNativeChatSkillDiscoveryContext(
        { ...floatingInputs, floatingWorkspacePath: null },
        'floating-chat-1'
      )
    ).toBeNull()
  })
})

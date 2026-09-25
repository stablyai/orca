import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import type { Tab } from '../../../../shared/tab-types'
import {
  isNativeChatSkillDiscoveryAwaitingDirectory,
  type NativeChatSkillStateInputs
} from './native-chat-skill-discovery-context'
import {
  isNativeChatSkillForAgent,
  resolveNativeChatSkillDiscoveryContext,
  resolveNativeChatSkillDiscoveryCwd
} from './use-native-chat-skills'

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: overrides.name ?? 'skill',
    name: 'agent-browser',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/Users/test/.agents/skills',
    directoryPath: '/Users/test/.agents/skills/agent-browser',
    skillFilePath: '/Users/test/.agents/skills/agent-browser/SKILL.md',
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

function discovery(owner: string | null, rootPath = '/Users/test/.agents/skills') {
  return {
    sources: [
      {
        id: 'source',
        label: 'Source',
        path: rootPath,
        sourceKind: 'home' as const,
        providers: ['agent-skills' as const],
        owner,
        exists: true
      }
    ]
  } satisfies Pick<SkillDiscoveryResult, 'sources'>
}

describe('isNativeChatSkillForAgent', () => {
  it('shows Codex-native and generic agent skills for Codex chat', () => {
    expect(isNativeChatSkillForAgent('codex', skill({ providers: ['codex'] }))).toBe(true)
    expect(isNativeChatSkillForAgent('codex', skill({ providers: ['agent-skills'] }))).toBe(true)
  })

  it('keeps Claude skills out of the Codex skill picker', () => {
    expect(isNativeChatSkillForAgent('codex', skill({ providers: ['claude'] }))).toBe(false)
  })

  it('does not enable skill autocomplete for other agents yet', () => {
    expect(isNativeChatSkillForAgent('claude', skill({ providers: ['agent-skills'] }))).toBe(false)
  })

  it('uses explicit source ownership and keeps shared roots visible', () => {
    const shared = discovery(null)
    expect(isNativeChatSkillForAgent('codex', skill({}), shared)).toBe(true)
    expect(isNativeChatSkillForAgent('claude', skill({}), shared)).toBe(true)
    expect(isNativeChatSkillForAgent('grok', skill({}), shared)).toBe(true)
  })

  it('aliases OpenClaude to Claude roots without exposing them to other agents', () => {
    const claude = discovery('claude')
    expect(isNativeChatSkillForAgent('claude', skill({}), claude)).toBe(true)
    expect(isNativeChatSkillForAgent('openclaude', skill({}), claude)).toBe(true)
    expect(isNativeChatSkillForAgent('codex', skill({}), claude)).toBe(false)
    expect(isNativeChatSkillForAgent('grok', skill({}), claude)).toBe(false)
  })

  it('grants visibility through any contributing root, not just the dedup survivor', () => {
    const result = {
      sources: [
        {
          id: 'codex-home',
          label: 'Codex home',
          path: '/Users/test/.codex/skills',
          sourceKind: 'home' as const,
          providers: ['codex' as const],
          owner: 'codex',
          exists: true
        },
        {
          id: 'shared-home',
          label: 'Agent skills home',
          path: '/Users/test/.agents/skills',
          sourceKind: 'home' as const,
          providers: ['agent-skills' as const],
          owner: null,
          exists: true
        }
      ]
    } satisfies Pick<SkillDiscoveryResult, 'sources'>
    // A symlinked skill deduped under the Codex root but also reachable
    // through the shared root stays visible to every agent.
    const merged = skill({
      rootPath: '/Users/test/.codex/skills',
      rootPaths: ['/Users/test/.codex/skills', '/Users/test/.agents/skills']
    })
    expect(isNativeChatSkillForAgent('claude', merged, result)).toBe(true)
    expect(isNativeChatSkillForAgent('codex', merged, result)).toBe(true)
    const codexOnly = skill({
      rootPath: '/Users/test/.codex/skills',
      rootPaths: ['/Users/test/.codex/skills']
    })
    expect(isNativeChatSkillForAgent('claude', codexOnly, result)).toBe(false)
  })
})

describe('resolveNativeChatSkillDiscoveryCwd', () => {
  it('returns the owning worktree path for a terminal tab', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd(
        {
          tabsByWorktree: {
            'repo-1::/repo/worktree': [
              {
                id: 'tab-1'
              }
            ]
          },
          worktreesByRepo: {
            'repo-1': [
              {
                id: 'repo-1::/repo/worktree',
                path: '/repo/worktree'
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
          tabsByWorktree: {},
          unifiedTabsByWorktree: {
            'repo-1::/repo/worktree': [{ id: 'structured-tab-1' }]
          },
          worktreesByRepo: {
            'repo-1': [{ id: 'repo-1::/repo/worktree', path: '/repo/worktree' }]
          }
        },
        'structured-tab-1'
      )
    ).toBe('/repo/worktree')
  })

  it('returns null when the tab has no known worktree owner', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd({ tabsByWorktree: {}, worktreesByRepo: {} }, 'tab-1')
    ).toBeNull()
  })

  it('prefers the pane startupCwd over the worktree root', () => {
    expect(
      resolveNativeChatSkillDiscoveryCwd(
        {
          tabsByWorktree: {
            'repo-1::/repo/worktree': [
              { id: 'tab-1', startupCwd: '/repo/worktree/packages/app' },
              { id: 'tab-2' }
            ]
          },
          worktreesByRepo: {
            'repo-1': [{ id: 'repo-1::/repo/worktree', path: '/repo/worktree' }]
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
    activeWorktreeId: null,
    floatingWorkspacePath: '/home/me/scratch',
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    // Why a focused runtime: floating must stay local even when one is selected.
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-1' },
    structuredSessionWorkspacePathByTabId: {},
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
      structuredSessionWorkspacePathByTabId: {
        'floating-chat-1': { sessionId: 'session-1', workspacePath: '/home/me/pinned' }
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

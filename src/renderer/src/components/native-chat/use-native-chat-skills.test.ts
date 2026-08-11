import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import {
  isNativeChatSkillForAgent,
  resolveNativeChatSkillDiscoveryContext,
  resolveNativeChatSkillDiscoveryCwd
} from './use-native-chat-skills'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

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
    fileCount: 1,
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

describe('resolveNativeChatSkillDiscoveryContext folder ownership', () => {
  const workspaceKey = folderWorkspaceKey('folder-1')
  const localFolder = {
    id: 'folder-1',
    projectGroupId: 'group-1',
    connectionId: null,
    executionHostId: 'local' as const,
    folderPath: '/workspace/local'
  }
  const sshFolder = {
    ...localFolder,
    connectionId: 'builder',
    executionHostId: 'ssh:builder' as const,
    folderPath: '/workspace/remote'
  }

  function folderState(reversed: boolean, active = true) {
    return {
      activeRepoId: null,
      activeWorktreeId: active ? workspaceKey : null,
      activeWorkspaceExecutionHostId: active ? 'ssh:builder' : null,
      folderWorkspaces: reversed ? [sshFolder, localFolder] : [localFolder, sshFolder],
      projectGroups: [],
      projects: [],
      repos: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { [workspaceKey]: [{ id: 'tab-1' }] },
      worktreesByRepo: {}
    } as never
  }

  it.each([false, true])('uses the active folder owner path (reversed=%s)', (reversed) => {
    expect(resolveNativeChatSkillDiscoveryContext(folderState(reversed), 'tab-1')).toMatchObject({
      cwd: '/workspace/remote',
      executionHostKind: 'ssh'
    })
  })

  it('fails closed for an inactive same-id folder collision', () => {
    expect(resolveNativeChatSkillDiscoveryContext(folderState(false, false), 'tab-1')).toBeNull()
  })

  it('routes paired SSH-source folders through their owning runtime', () => {
    const pairedFolder = {
      ...sshFolder,
      executionHostId: 'runtime:hub' as const,
      runtimeSourceExecutionHostId: 'ssh:builder' as const
    }
    const state = {
      ...(folderState(false, false) as unknown as Record<string, unknown>),
      folderWorkspaces: [pairedFolder]
    } as never

    expect(resolveNativeChatSkillDiscoveryContext(state, 'tab-1')).toMatchObject({
      cwd: '/workspace/remote',
      executionHostKind: 'runtime',
      runtimeTarget: { kind: 'environment', environmentId: 'hub' }
    })
  })
})

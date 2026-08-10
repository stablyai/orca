import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import type { AppState } from '../../store/types'
import {
  isNativeChatSkillForAgent,
  resolveNativeChatSkillDiscoveryContext,
  resolveNativeChatSkillDiscoveryCwd
} from './use-native-chat-skills'
import {
  getNativeChatSkillDiscoverySubscriptionKey,
  selectNativeChatSkillStateInputs,
  type NativeChatSkillStateInputs
} from './native-chat-skill-discovery-context'

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

function connectionState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId: 'target-1',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    connectionGeneration: 7,
    ...overrides
  }
}

function sshInputs(overrides: Record<string, unknown> = {}): NativeChatSkillStateInputs {
  return {
    activeRepoId: 'repo-1',
    activeWorkspaceExecutionHostId: null,
    activeWorktreeId: 'worktree-1',
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'ssh:target-1' }],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironments: [],
    settings: { activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map([['target-1', connectionState()]]),
    sshStateByEnvironment: new Map(),
    tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
    worktreesByRepo: {
      'repo-1': [
        { id: 'worktree-1', repoId: 'repo-1', path: '/repo/worktree', hostId: 'ssh:target-1' }
      ]
    },
    ...overrides
  } as unknown as NativeChatSkillStateInputs
}

function selectedSshInputs(overrides: Record<string, unknown>): NativeChatSkillStateInputs {
  return selectNativeChatSkillStateInputs(sshInputs(overrides) as unknown as AppState)
}

describe('resolveNativeChatSkillDiscoveryContext for SSH panes', () => {
  it('builds a pane-bound SSH context keyed on the connection generation', () => {
    const context = resolveNativeChatSkillDiscoveryContext(sshInputs(), 'tab-1')
    expect(context?.executionHostKind).toBe('ssh')
    if (context?.executionHostKind !== 'ssh') {
      throw new Error('expected ssh context')
    }
    expect(context.runtimeTarget).toEqual({ kind: 'local' })
    expect(context.paneTarget).toEqual({ worktreeId: 'worktree-1', terminalTabId: 'tab-1' })
    expect(context.sshDisconnected).toBe(false)
    expect(context.key).toContain('7')

    const regenerated = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        sshConnectionStates: new Map([['target-1', connectionState({ connectionGeneration: 8 })]])
      }),
      'tab-1'
    )
    // Reconnect bumps the generation, which must invalidate the pane cache key.
    expect(regenerated?.key).not.toBe(context.key)
  })

  it('marks a missing or non-connected local SSH state as disconnected', () => {
    const missing = resolveNativeChatSkillDiscoveryContext(
      sshInputs({ sshConnectionStates: new Map() }),
      'tab-1'
    )
    const reconnecting = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        sshConnectionStates: new Map([['target-1', connectionState({ status: 'reconnecting' })]])
      }),
      'tab-1'
    )
    expect(missing?.executionHostKind === 'ssh' && missing.sshDisconnected).toBe(true)
    expect(reconnecting?.executionHostKind === 'ssh' && reconnecting.sshDisconnected).toBe(true)
  })

  it('fails closed for a runtime-owned SSH target without an explicit owner', () => {
    const context = resolveNativeChatSkillDiscoveryContext(
      sshInputs({
        repos: [
          { id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'ssh:runtime-ssh-t1' }
        ],
        worktreesByRepo: {
          'repo-1': [
            {
              id: 'worktree-1',
              repoId: 'repo-1',
              path: '/repo/worktree',
              hostId: 'ssh:runtime-ssh-t1'
            }
          ]
        }
      }),
      'tab-1'
    )
    expect(context).toBeNull()
  })

  it('routes an owner-stamped runtime SSH target through its environment', () => {
    const context = resolveNativeChatSkillDiscoveryContext(
      sshInputs({
        repos: [
          { id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'ssh:runtime-ssh-t1' }
        ],
        worktreesByRepo: {
          'repo-1': [
            {
              id: 'worktree-1',
              repoId: 'repo-1',
              path: '/repo/worktree',
              hostId: 'ssh:runtime-ssh-t1',
              runtimeOwnerEnvironmentId: 'env-1'
            }
          ]
        },
        sshStateByEnvironment: new Map([
          [
            'env-1',
            {
              connectionStates: new Map([
                [
                  'runtime-ssh-t1',
                  connectionState({ targetId: 'runtime-ssh-t1', connectionGeneration: 4 })
                ]
              ]),
              targetLabels: new Map(),
              removedTargetLabels: new Map(),
              targetsHydrated: true
            }
          ]
        ])
      }),
      'tab-1'
    )
    expect(context?.executionHostKind).toBe('ssh')
    if (context?.executionHostKind !== 'ssh') {
      throw new Error('expected ssh context')
    }
    expect(context.runtimeTarget).toEqual({ kind: 'environment', environmentId: 'env-1' })
    expect(context.key).toContain('env-1')
    expect(context.key).toContain('4')
    expect(context.sshDisconnected).toBe(false)
  })

  it('keeps a non-ephemeral paired SSH target on its owning runtime', () => {
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        repos: [],
        sshConnectionStates: new Map([
          ['private-target', connectionState({ targetId: 'private-target' })]
        ]),
        sshStateByEnvironment: new Map([
          [
            'hub-a',
            {
              connectionStates: new Map([
                ['private-target', connectionState({ targetId: 'private-target' })]
              ])
            }
          ]
        ]),
        worktreesByRepo: {
          'repo-1': [
            {
              id: 'worktree-1',
              repoId: 'repo-1',
              path: '/repo/worktree',
              hostId: 'ssh:private-target',
              runtimeOwnerEnvironmentId: 'hub-a'
            }
          ]
        }
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('ssh')
    if (context?.executionHostKind !== 'ssh') {
      throw new Error('expected ssh context')
    }
    expect(context.runtimeTarget).toEqual({ kind: 'environment', environmentId: 'hub-a' })
  })

  it('treats an unhydrated environment bucket as unknown rather than disconnected', () => {
    const context = resolveNativeChatSkillDiscoveryContext(
      sshInputs({
        repos: [
          { id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'ssh:runtime-ssh-t1' }
        ],
        worktreesByRepo: {
          'repo-1': [
            {
              id: 'worktree-1',
              repoId: 'repo-1',
              path: '/repo/worktree',
              hostId: 'ssh:runtime-ssh-t1',
              runtimeOwnerEnvironmentId: 'env-1'
            }
          ]
        }
      }),
      'tab-1'
    )
    expect(context?.executionHostKind === 'ssh' && context.sshDisconnected).toBe(false)
  })

  it('uses pane identity when the SSH worktree catalog has not hydrated a cwd', () => {
    const worktreeId = 'repo-1::/repo/worktree'
    const context = resolveNativeChatSkillDiscoveryContext(
      sshInputs({
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('ssh')
    if (context?.executionHostKind !== 'ssh') {
      throw new Error('expected ssh context')
    }
    expect(context.paneTarget).toEqual({ worktreeId, terminalTabId: 'tab-1' })
  })

  it('uses a restored paired runtime owner before the worktree catalog hydrates', () => {
    const worktreeId = 'repo-1::/remote/repo'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'ssh:private-target',
        activeWorktreeId: worktreeId,
        repos: [],
        restoredRuntimeHostIdByWorkspaceSessionKey: { [worktreeId]: 'runtime:hub-a' },
        sshConnectionStates: new Map([
          ['private-target', connectionState({ targetId: 'private-target' })]
        ]),
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('ssh')
    expect(context?.runtimeTarget).toEqual({ kind: 'environment', environmentId: 'hub-a' })
  })

  it('uses the active SSH host while duplicate catalogs are still hydrating', () => {
    const worktreeId = 'repo-1::/remote/repo'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'ssh:target-2',
        activeWorktreeId: worktreeId,
        repos: [
          { id: 'repo-1', path: '/remote/repo', connectionId: 'target-1' },
          { id: 'repo-1', path: '/remote/repo', connectionId: 'target-2' }
        ],
        sshConnectionStates: new Map([['target-2', connectionState({ targetId: 'target-2' })]]),
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('ssh')
    expect(context?.key).toContain('ssh:target-2')
  })

  it('uses a detected-only SSH owner before the primary worktree catalog hydrates', () => {
    const worktreeId = 'repo-1::/remote/repo'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorktreeId: 'other-worktree',
        detectedWorktreesByRepo: {
          'repo-1': {
            worktrees: [
              {
                id: worktreeId,
                repoId: 'repo-1',
                path: '/remote/repo',
                hostId: 'ssh:target-2'
              }
            ]
          }
        },
        repos: [
          { id: 'repo-1', path: '/remote/repo', connectionId: 'target-1' },
          { id: 'repo-1', path: '/remote/repo', connectionId: 'target-2' }
        ],
        sshConnectionStates: new Map([['target-2', connectionState({ targetId: 'target-2' })]]),
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('ssh')
    expect(context?.key).toContain('ssh:target-2')
  })

  it('fails closed when two runtimes project a local SSH target id', () => {
    const worktreeId = 'repo-1::/remote/repo'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'ssh:shared-target',
        activeWorktreeId: worktreeId,
        repos: [],
        sshConnectionStates: new Map([
          ['shared-target', connectionState({ targetId: 'shared-target' })]
        ]),
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {
          'repo-1': [
            {
              id: worktreeId,
              repoId: 'repo-1',
              path: '/remote/repo',
              hostId: 'ssh:shared-target',
              runtimeOwnerEnvironmentId: 'hub-a'
            },
            {
              id: worktreeId,
              repoId: 'repo-1',
              path: '/remote/repo',
              hostId: 'ssh:shared-target',
              runtimeOwnerEnvironmentId: 'hub-b'
            }
          ]
        }
      }),
      'tab-1'
    )

    expect(context).toBeNull()
  })

  it('fails closed when direct and paired panes share an SSH target id', () => {
    const worktreeId = 'repo-1::/remote/repo'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'ssh:shared-target',
        activeWorktreeId: worktreeId,
        repos: [],
        sshConnectionStates: new Map([
          ['shared-target', connectionState({ targetId: 'shared-target' })]
        ]),
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {
          'repo-1': [
            {
              id: worktreeId,
              repoId: 'repo-1',
              path: '/remote/repo',
              hostId: 'ssh:shared-target'
            },
            {
              id: worktreeId,
              repoId: 'repo-1',
              path: '/remote/repo',
              hostId: 'ssh:shared-target',
              runtimeOwnerEnvironmentId: 'hub-a'
            }
          ]
        }
      }),
      'tab-1'
    )

    expect(context).toBeNull()
  })

  it('fails closed before a direct repo row hydrates beside a paired repo fallback', () => {
    const worktreeId = 'repo-1::/remote/repo'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'ssh:shared-target',
        activeWorktreeId: worktreeId,
        repos: [
          {
            id: 'repo-1',
            path: '/remote/repo',
            connectionId: 'shared-target',
            executionHostId: 'runtime:hub-a'
          }
        ],
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {
          'repo-1': [
            {
              id: worktreeId,
              repoId: 'repo-1',
              path: '/remote/repo',
              hostId: 'ssh:shared-target'
            },
            {
              id: worktreeId,
              repoId: 'repo-1',
              path: '/remote/repo',
              hostId: 'ssh:shared-target',
              runtimeOwnerEnvironmentId: 'hub-a'
            }
          ]
        }
      }),
      'tab-1'
    )

    expect(context).toBeNull()
  })

  it('resolves paired transport across equivalent Windows worktree ids', () => {
    const paneWorktreeId = 'repo-1::C:\\remote\\repo'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'ssh:private-target',
        activeWorktreeId: paneWorktreeId,
        repos: [],
        sshConnectionStates: new Map([
          ['private-target', connectionState({ targetId: 'private-target' })]
        ]),
        tabsByWorktree: { [paneWorktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {
          'repo-1': [
            {
              id: 'repo-1::c:/remote/repo',
              repoId: 'repo-1',
              path: 'c:/remote/repo',
              hostId: 'ssh:private-target',
              runtimeOwnerEnvironmentId: 'hub-a'
            }
          ]
        }
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('ssh')
    if (context?.executionHostKind !== 'ssh') {
      throw new Error('expected ssh context')
    }
    expect(context.runtimeTarget).toEqual({ kind: 'environment', environmentId: 'hub-a' })
  })

  it('uses pane discovery for an SSH folder projected through a runtime', () => {
    const worktreeId = 'folder:folder-1'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'runtime:hub-a',
        activeWorktreeId: worktreeId,
        folderWorkspaces: [
          {
            id: 'folder-1',
            projectGroupId: 'group-1',
            folderPath: '/remote/folder',
            executionHostId: 'runtime:hub-a'
          }
        ],
        projectGroups: [
          {
            id: 'group-1',
            connectionId: 'private-target',
            executionHostId: 'runtime:hub-a'
          }
        ],
        repos: [],
        sshStateByEnvironment: new Map([
          [
            'hub-a',
            {
              connectionStates: new Map([
                ['private-target', connectionState({ targetId: 'private-target' })]
              ])
            }
          ]
        ]),
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('ssh')
    if (context?.executionHostKind !== 'ssh') {
      throw new Error('expected ssh context')
    }
    expect(context.runtimeTarget).toEqual({ kind: 'environment', environmentId: 'hub-a' })
    expect(context.paneTarget).toEqual({ worktreeId, terminalTabId: 'tab-1' })
  })

  it('isolates a paired SSH folder from a duplicate local folder id', () => {
    const worktreeId = 'folder:folder-1'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'runtime:hub-a',
        activeWorktreeId: worktreeId,
        folderWorkspaces: [
          {
            id: 'folder-1',
            projectGroupId: 'local-group',
            folderPath: '/local/folder',
            executionHostId: 'local'
          },
          {
            id: 'folder-1',
            projectGroupId: 'remote-group',
            folderPath: '/remote/folder',
            executionHostId: 'runtime:hub-a'
          }
        ],
        projectGroups: [
          { id: 'local-group', executionHostId: 'local' },
          {
            id: 'remote-group',
            connectionId: 'private-target',
            executionHostId: 'runtime:hub-a'
          }
        ],
        repos: [],
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('ssh')
    expect(context?.runtimeTarget).toEqual({ kind: 'environment', environmentId: 'hub-a' })
  })

  it('fails closed while a restored runtime folder catalog is missing', () => {
    const worktreeId = 'folder:folder-1'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'runtime:hub-a',
        activeWorktreeId: worktreeId,
        folderWorkspaces: [],
        projectGroups: [],
        repos: [],
        restoredRuntimeHostIdByWorkspaceSessionKey: { [worktreeId]: 'runtime:hub-a' },
        tabsByWorktree: {
          [worktreeId]: [{ id: 'tab-1', startupCwd: '/possibly-remote/folder' }]
        },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context).toBeNull()
  })

  it('fails closed before a runtime folder project group hydrates', () => {
    const worktreeId = 'folder:folder-1'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'runtime:hub-a',
        activeWorktreeId: worktreeId,
        folderWorkspaces: [
          {
            id: 'folder-1',
            projectGroupId: 'group-1',
            folderPath: '/possibly-remote/folder',
            executionHostId: 'runtime:hub-a'
          }
        ],
        projectGroups: [],
        repos: [],
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context).toBeNull()
  })

  it('keeps a fully hydrated runtime-local folder on normal discovery', () => {
    const worktreeId = 'folder:folder-1'
    const context = resolveNativeChatSkillDiscoveryContext(
      selectedSshInputs({
        activeWorkspaceExecutionHostId: 'runtime:hub-a',
        activeWorktreeId: worktreeId,
        folderWorkspaces: [
          {
            id: 'folder-1',
            projectGroupId: 'group-1',
            folderPath: '/runtime/folder',
            executionHostId: 'runtime:hub-a'
          }
        ],
        projectGroups: [{ id: 'group-1', executionHostId: 'runtime:hub-a' }],
        repos: [],
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
        worktreesByRepo: {}
      }),
      'tab-1'
    )

    expect(context?.executionHostKind).toBe('runtime')
    expect(context?.runtimeTarget).toEqual({ kind: 'environment', environmentId: 'hub-a' })
  })

  it('keeps the same remote path on two SSH hosts cache-isolated', () => {
    const onTargetTwo = resolveNativeChatSkillDiscoveryContext(
      sshInputs({
        repos: [
          { id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'ssh:target-2' }
        ],
        worktreesByRepo: {
          'repo-1': [
            { id: 'worktree-1', repoId: 'repo-1', path: '/repo/worktree', hostId: 'ssh:target-2' }
          ]
        },
        sshConnectionStates: new Map([['target-2', connectionState({ targetId: 'target-2' })]])
      }),
      'tab-1'
    )
    const onTargetOne = resolveNativeChatSkillDiscoveryContext(sshInputs(), 'tab-1')
    expect(onTargetOne?.key).not.toBe(onTargetTwo?.key)
  })

  it('keeps pane identity in the key when renderer paths are stale or equal', () => {
    const firstPane = resolveNativeChatSkillDiscoveryContext(sshInputs(), 'tab-1')
    const secondPane = resolveNativeChatSkillDiscoveryContext(
      sshInputs({
        tabsByWorktree: { 'worktree-2': [{ id: 'tab-2' }] },
        worktreesByRepo: {
          'repo-1': [
            { id: 'worktree-2', repoId: 'repo-1', path: '/repo/worktree', hostId: 'ssh:target-1' }
          ]
        }
      }),
      'tab-2'
    )
    expect(firstPane?.key).not.toBe(secondPane?.key)
  })

  it('ignores unrelated SSH state updates in the hook subscription key', () => {
    const initial = sshInputs()
    const unrelatedUpdate = sshInputs({
      sshConnectionStates: new Map([
        ['target-1', connectionState()],
        ['target-2', connectionState({ targetId: 'target-2', connectionGeneration: 99 })]
      ])
    })
    expect(
      getNativeChatSkillDiscoverySubscriptionKey(
        resolveNativeChatSkillDiscoveryContext(unrelatedUpdate, 'tab-1')
      )
    ).toBe(
      getNativeChatSkillDiscoverySubscriptionKey(
        resolveNativeChatSkillDiscoveryContext(initial, 'tab-1')
      )
    )
  })
})

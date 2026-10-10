import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createWorktreeIdentity } from '../../../../shared/worktree/identity'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { repoWithFetchedOwner } from '../../store/repos/owner-routing'
import { setupWithFetchedOwner } from '../../store/projects/project-host-routing'
import { automationRepoForRow, automationWorktreeForRow } from './automation-list-row-identity'
import { withRepoHostOwnership } from '../../store/slices/worktrees/listing/worktree-host-ownership'

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Nightly',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'worktree-1',
    baseBranch: null,
    reuseSession: false,
    timezone: 'America/Los_Angeles',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeWorkspace(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    repoId: 'repo-1',
    path: '/repo',
    displayName: 'Main',
    ...overrides
  } as Worktree
}

function makeProjectHostSetup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-1',
    projectId: 'project-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRuntimeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'runtime-1',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 2,
    ...overrides
  }
}

describe('automation target availability', () => {
  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, false],
    [false, false, true],
    [false, true, true],
    [true, false, true],
    [true, true, true]
  ])(
    'joins the saved raw repo/workspace owner (paired: %s, selected first: %s, same path: %s)',
    (paired, selectedFirst, samePath) => {
      const target = paired
        ? ({ kind: 'environment', environmentId: 'gpu' } as const)
        : ({ kind: 'local' } as const)
      const aHost = paired ? 'ssh:a' : 'local'
      const a = repoWithFetchedOwner(
        makeRepo({ executionHostId: aHost, path: samePath ? '/repo' : '/repo/a' }),
        target
      )
      const b = repoWithFetchedOwner(
        makeRepo({ executionHostId: 'ssh:b', path: samePath ? '/repo' : '/repo/b' }),
        target
      )
      const setups = ([aHost, 'ssh:b'] as const).map((host) =>
        setupWithFetchedOwner(
          makeProjectHostSetup({ hostId: host, path: host === 'ssh:b' ? b.path : a.path }),
          target
        )
      )
      const automation = makeAutomation({
        runContext: {
          kind: 'workspace-run',
          projectId: 'project-1',
          hostId: 'ssh:b',
          projectHostSetupId: 'setup-1',
          repoId: b.id,
          path: b.path
        }
      })
      const row = {
        key: 'row',
        automation,
        hostLabel: '',
        usageSummary: null,
        catalogRef: {
          authority: paired
            ? ({ kind: 'runtime', environmentId: 'gpu' } as const)
            : ({ kind: 'desktop' } as const),
          selector: { kind: 'ssh', targetId: 'b' } as const
        }
      }
      const repos = selectedFirst ? [b, a] : [a, b]
      const selectedRepo = automationRepoForRow(row, repos, new Map([[b.id, a]]))
      expect(selectedRepo).toBe(b)
      expect(automationRepoForRow(row, [a], new Map([[b.id, a]]))).toBeUndefined()
      expect(automationRepoForRow(row, [b, { ...b }], new Map([[b.id, a]]))).toBeUndefined()
      const workspaceA = withRepoHostOwnership(
        makeWorkspace({ hostId: aHost, path: '/repo/a/linked-checkout' }),
        a.executionHostId ?? 'local'
      )
      const workspaceB = withRepoHostOwnership(
        makeWorkspace({ hostId: 'ssh:b', path: '/repo/b/linked-checkout' }),
        b.executionHostId ?? 'local'
      )
      const workspace = automationWorktreeForRow(
        row,
        { [b.id]: [workspaceA, workspaceB] },
        selectedRepo,
        new Map([[workspaceB.id, workspaceA]])
      )
      expect(workspace).toBe(workspaceB)
      expect(
        automationWorktreeForRow(row, {}, undefined, new Map([[workspaceB.id, workspaceA]]))
      ).toBeUndefined()
      expect(
        automationWorktreeForRow(
          row,
          { [b.id]: [workspaceA] },
          b,
          new Map([[workspaceB.id, workspaceA]])
        )
      ).toBeUndefined()
      expect(
        automationWorktreeForRow(
          row,
          { [b.id]: [workspaceB, { ...workspaceB, instanceId: 'other-instance' }] },
          b,
          new Map()
        )
      ).toBeUndefined()
      const args = {
        automation,
        repo: selectedRepo,
        workspace,
        projectHostSetups: setups,
        sshConnectionStates: new Map([['b', { status: 'connected' as const }]]),
        automationHostTarget: target
      }
      expect(getAutomationTargetAvailability(args)).toEqual({
        canRunNow: true,
        reason: 'available',
        message: null
      })
      expect(getAutomationTargetAvailability({ ...args, repo: a }).reason).toBe('host-mismatch')
    }
  )
  it.each(['receiver', 'publisher'] as const)(
    'refuses an explicitly different %s backing repo',
    (mismatch) => {
      const target = { kind: 'environment', environmentId: 'gpu' } as const
      const setup = setupWithFetchedOwner(makeProjectHostSetup({ hostId: 'ssh:b' }), target)
      const repo = repoWithFetchedOwner(
        makeRepo({ executionHostId: mismatch === 'receiver' ? 'ssh:a' : 'ssh:b' }),
        mismatch === 'publisher' ? { kind: 'environment', environmentId: 'other' } : target
      )
      expect(
        getAutomationTargetAvailability({
          automation: makeAutomation({
            runContext: {
              kind: 'workspace-run',
              projectId: 'project-1',
              hostId: 'ssh:b',
              projectHostSetupId: 'setup-1',
              repoId: repo.id,
              path: repo.path
            }
          }),
          repo,
          workspace: makeWorkspace(),
          projectHostSetups: [setup],
          sshConnectionStates: new Map([['b', { status: 'connected' }]]),
          automationHostTarget: target
        }).reason
      ).toBe('host-mismatch')
    }
  )
  it.each([
    ['local', false],
    ['local', true],
    ['runtime:gpu', false],
    ['runtime:gpu', true]
  ] as const)(
    'keeps immutable raw owner %s through the runtime display alias (first: %s)',
    (rawHost, first) => {
      const target = { kind: 'environment', environmentId: 'gpu' } as const
      const repo = repoWithFetchedOwner(makeRepo({ executionHostId: rawHost }), target)
      const rows = (['local', 'runtime:gpu'] as const).map((host) =>
        withRepoHostOwnership(
          makeWorkspace({
            identity: createWorktreeIdentity({
              executionHostId: host,
              worktreeId: 'worktree-1',
              instanceId: host
            })
          }),
          'runtime:gpu'
        )
      )
      const selected = rows.find((workspace) => workspace.identity?.executionHostId === rawHost)!
      const sibling = rows.find((workspace) => workspace !== selected)!
      const row = {
        key: 'row',
        hostLabel: '',
        usageSummary: null,
        automation: makeAutomation({
          runContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            projectHostSetupId: 'setup-1',
            repoId: repo.id,
            path: repo.path,
            hostId: rawHost
          }
        }),
        catalogRef: {
          authority: { kind: 'runtime', environmentId: 'gpu' } as const,
          selector: { kind: 'self' } as const
        }
      }
      expect(
        automationWorktreeForRow(
          row,
          { [repo.id]: first ? [selected, sibling] : [sibling, selected] },
          repo,
          new Map()
        )
      ).toBe(selected)
      expect(
        automationWorktreeForRow(
          row,
          { [repo.id]: [sibling] },
          repo,
          new Map([[selected.id, sibling]])
        )
      ).toBeUndefined()
    }
  )
  it.each(['local', 'ssh:devbox'] as const)(
    'selects the captured publisher before raw host %s and setup ID',
    (rawHost) => {
      const targets = [
        { kind: 'local' },
        { kind: 'environment', environmentId: 'gpu' },
        { kind: 'environment', environmentId: 'other' }
      ] as const
      const setups = targets.map((target) =>
        setupWithFetchedOwner(makeProjectHostSetup({ hostId: rawHost }), target)
      )
      for (const target of targets) {
        const repo = repoWithFetchedOwner(makeRepo({ executionHostId: rawHost }), target)
        expect(
          getAutomationTargetAvailability({
            automation: makeAutomation({
              runContext: {
                kind: 'workspace-run',
                projectId: 'project-1',
                hostId: rawHost,
                projectHostSetupId: 'setup-1',
                repoId: repo.id,
                path: repo.path
              }
            }),
            repo,
            workspace: makeWorkspace(),
            projectHostSetups: setups,
            sshConnectionStates: new Map([['devbox', { status: 'connected' }]]),
            automationHostTarget: target
          })
        ).toEqual({ canRunNow: true, reason: 'available', message: null })
      }
    }
  )
  it('allows local automations with an available existing workspace', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation(),
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [],
        sshConnectionStates: new Map()
      })
    ).toEqual({ canRunNow: true, reason: 'available', message: null })
  })

  it('blocks missing projects and missing existing workspaces', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation(),
        repo: null,
        workspace: makeWorkspace(),
        projectHostSetups: [],
        sshConnectionStates: new Map()
      }).reason
    ).toBe('missing-project')

    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation(),
        repo: makeRepo(),
        workspace: null,
        projectHostSetups: [],
        sshConnectionStates: new Map()
      }).reason
    ).toBe('missing-workspace')
  })

  it('blocks a saved run context that no longer matches the repo host setup', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          runContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'ssh:devbox',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/repo'
          }
        }),
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [makeProjectHostSetup()],
        sshConnectionStates: new Map()
      }).reason
    ).toBe('missing-project-host-setup')
  })

  it('allows a run context whose derived projectId tier drifted but repo/host/path still match', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          runContext: {
            kind: 'workspace-run',
            // Snapshotted at the repo: tier before the setup climbed to github:.
            projectId: 'repo:repo-1',
            hostId: 'local',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/repo'
          }
        }),
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [makeProjectHostSetup({ projectId: 'github:o/r' })],
        sshConnectionStates: new Map()
      })
    ).toEqual({ canRunNow: true, reason: 'available', message: null })
  })

  it('still blocks a run context whose repoId no longer matches despite projectId drift', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          runContext: {
            kind: 'workspace-run',
            projectId: 'repo:repo-2',
            hostId: 'local',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-2',
            path: '/repo'
          }
        }),
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [makeProjectHostSetup({ projectId: 'github:o/r', repoId: 'repo-2' })],
        sshConnectionStates: new Map()
      }).reason
    ).toBe('host-mismatch')
  })

  it('still blocks when the setup repoId drifts even though the live repo still matches', () => {
    // Live repo matches runContext.repoId (repoMatchesContext passes), so this
    // isolates the setup-side repoId clause that survives the projectId removal.
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          runContext: {
            kind: 'workspace-run',
            projectId: 'repo:repo-1',
            hostId: 'local',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/repo'
          }
        }),
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [makeProjectHostSetup({ projectId: 'github:o/r', repoId: 'repo-2' })],
        sshConnectionStates: new Map()
      }).reason
    ).toBe('host-mismatch')
  })

  it('allows remote-listed SSH automations whose repo is projected through a runtime server', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          executionTargetType: 'ssh',
          executionTargetId: 'devbox',
          runContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'ssh:devbox',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/repo'
          }
        }),
        repo: makeRepo({
          connectionId: 'devbox',
          executionHostId: 'runtime:gpu'
        }),
        workspace: makeWorkspace(),
        projectHostSetups: [
          makeProjectHostSetup({
            hostId: 'ssh:devbox',
            connectionId: 'devbox',
            executionHostId: 'ssh:devbox'
          })
        ],
        sshConnectionStates: new Map([['devbox', { status: 'connected' }]]),
        automationHostTarget: { kind: 'environment', environmentId: 'gpu' }
      })
    ).toEqual({ canRunNow: true, reason: 'available', message: null })
  })

  it('allows remote-listed server-local automations whose setup is projected through a runtime server', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          runContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'local',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/repo'
          }
        }),
        repo: makeRepo({ executionHostId: 'runtime:gpu' }),
        workspace: makeWorkspace(),
        projectHostSetups: [
          makeProjectHostSetup({
            hostId: 'runtime:gpu',
            executionHostId: 'runtime:gpu'
          })
        ],
        sshConnectionStates: new Map(),
        automationHostTarget: { kind: 'environment', environmentId: 'gpu' }
      })
    ).toEqual({ canRunNow: true, reason: 'available', message: null })
  })

  it('blocks saved run contexts whose project host setup is missing or not ready', () => {
    const automation = makeAutomation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'local',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })

    expect(
      getAutomationTargetAvailability({
        automation,
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [],
        sshConnectionStates: new Map()
      }).reason
    ).toBe('missing-project-host-setup')

    expect(
      getAutomationTargetAvailability({
        automation,
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [makeProjectHostSetup({ setupState: 'error' })],
        sshConnectionStates: new Map()
      })
    ).toMatchObject({
      reason: 'project-host-setup-not-ready',
      message: 'Project setup on the selected automation host is error.'
    })
  })

  it('requires SSH hosts to be connected before manual runs', () => {
    const automation = makeAutomation({
      executionTargetType: 'ssh',
      executionTargetId: 'devbox',
      runContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'ssh:devbox',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })
    const repo = makeRepo({ connectionId: 'devbox', executionHostId: 'ssh:devbox' })

    expect(
      getAutomationTargetAvailability({
        automation,
        repo,
        workspace: makeWorkspace(),
        projectHostSetups: [
          makeProjectHostSetup({
            hostId: 'ssh:devbox',
            connectionId: 'devbox',
            executionHostId: 'ssh:devbox'
          })
        ],
        sshConnectionStates: new Map([['devbox', { status: 'connected' }]])
      }).canRunNow
    ).toBe(true)

    expect(
      getAutomationTargetAvailability({
        automation,
        repo,
        workspace: makeWorkspace(),
        projectHostSetups: [
          makeProjectHostSetup({
            hostId: 'ssh:devbox',
            connectionId: 'devbox',
            executionHostId: 'ssh:devbox'
          })
        ],
        sshConnectionStates: new Map([['devbox', { status: 'disconnected' }]])
      }).reason
    ).toBe('ssh-unavailable')

    expect(
      getAutomationTargetAvailability({
        automation,
        repo,
        workspace: makeWorkspace(),
        projectHostSetups: [
          makeProjectHostSetup({
            hostId: 'ssh:devbox',
            connectionId: 'devbox',
            executionHostId: 'ssh:devbox'
          })
        ],
        sshConnectionStates: new Map([['devbox', { status: 'auth-failed' }]])
      }).reason
    ).toBe('ssh-auth-needed')

    expect(
      getAutomationTargetAvailability({
        automation,
        repo,
        workspace: makeWorkspace(),
        projectHostSetups: [
          makeProjectHostSetup({
            hostId: 'ssh:devbox',
            connectionId: 'devbox',
            executionHostId: 'ssh:devbox'
          })
        ],
        sshConnectionStates: new Map([['devbox', { status: 'reconnecting' }]])
      }).reason
    ).toBe('ssh-connecting')
  })

  it('blocks manual runs when the saved source account needs provider auth', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          sourceContext: {
            kind: 'task-source',
            provider: 'github',
            projectId: 'github:stablyai/orca',
            hostId: 'local',
            repoId: 'repo-1',
            providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
          }
        }),
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [],
        sshConnectionStates: new Map(),
        sourceHostAvailability: [{ hostId: 'local', reason: 'missing-provider-auth' }]
      })
    ).toMatchObject({
      canRunNow: false,
      reason: 'source-auth-needed',
      message: 'Connect the saved GitHub source account before running manually.'
    })
  })

  it('blocks manual runs when the saved source host cannot support the provider', () => {
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          sourceContext: {
            kind: 'task-source',
            provider: 'gitlab',
            projectId: 'gitlab:stablyai/orca',
            hostId: 'runtime:old-server',
            repoId: 'repo-1',
            providerIdentity: {
              provider: 'gitlab',
              projectId: 'stablyai/orca',
              namespace: 'stablyai',
              project: 'orca',
              webUrl: 'https://gitlab.com/stablyai/orca'
            }
          }
        }),
        repo: makeRepo(),
        workspace: makeWorkspace(),
        projectHostSetups: [],
        sshConnectionStates: new Map(),
        sourceHostAvailability: [
          { hostId: 'runtime:old-server', reason: 'missing-task-source-capability' }
        ]
      })
    ).toMatchObject({
      canRunNow: false,
      reason: 'source-provider-unsupported',
      message: 'The saved GitLab source is not supported on this automation host.'
    })
  })

  it('explains runtime-host automation availability before the unsupported manual-run fallback', () => {
    const automation = makeAutomation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'runtime:env-1',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })
    const repo = makeRepo({ executionHostId: 'runtime:env-1' })
    const setup = makeProjectHostSetup({
      hostId: 'runtime:env-1',
      executionHostId: 'runtime:env-1'
    })
    const base = {
      automation,
      repo,
      workspace: makeWorkspace(),
      projectHostSetups: [setup],
      sshConnectionStates: new Map()
    }

    expect(getAutomationTargetAvailability(base).reason).toBe('runtime-checking')
    expect(
      getAutomationTargetAvailability({
        ...base,
        runtimeStatusByEnvironmentId: new Map([['env-1', { status: null, checkedAt: 1 }]])
      }).reason
    ).toBe('runtime-unavailable')
    expect(
      getAutomationTargetAvailability({
        ...base,
        runtimeStatusByEnvironmentId: new Map([
          ['env-1', { status: makeRuntimeStatus({ graphStatus: 'unavailable' }), checkedAt: 1 }]
        ])
      }).message
    ).toBe('The selected remote server is not ready to run automations yet.')
    expect(
      getAutomationTargetAvailability({
        ...base,
        runtimeStatusByEnvironmentId: new Map([
          ['env-1', { status: makeRuntimeStatus({ runtimeProtocolVersion: 0 }), checkedAt: 1 }]
        ])
      }).reason
    ).toBe('runtime-update-required')
    expect(
      getAutomationTargetAvailability({
        ...base,
        runtimeStatusByEnvironmentId: new Map([
          ['env-1', { status: makeRuntimeStatus(), checkedAt: 1 }]
        ])
      })
    ).toMatchObject({
      reason: 'available',
      message: null
    })
  })
})

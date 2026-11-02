// @vitest-environment happy-dom

import { registerCapturedAutomationRunActionTests } from './automation-captured-run-actions.spec'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { cleanup } from '@testing-library/react'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getAutomationTargetAvailability } from './automation-target-availability'
import type { AppState } from '@/store/types'
import {
  adoptEndpointRepo,
  adoptEndpointProjectHostSetup
} from '../../../../shared/endpoint-catalog-adoption'
import { withRepoHostOwnership } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { mergeFetchedReposForHost } from '@/store/repos/repo-catalog-identity'
import { mergeProjectHostSetupsByOwner } from '../../../../shared/project-compatibility-merge'
import { resolveOwner } from '@/lib/resolve-owner'

const actionMocks = vi.hoisted(() => {
  const state: Partial<AppState> = {}
  return {
    rpc: vi.fn(),
    interaction: vi.fn<AppState['recordFeatureInteraction']>(async () => {}),
    error: vi.fn(),
    state
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: actionMocks.rpc,
  getRuntimeEnvironmentStatus: vi.fn(async () => ({
    capabilities: ['automation.owner-fencing.v1']
  }))
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Partial<AppState>) => unknown) => selector(actionMocks.state),
    {
      getState: () => actionMocks.state
    }
  )
}))
vi.mock('@/store/selectors', () => ({
  useRepoMap: () => new Map((actionMocks.state.repos ?? []).map((repo) => [repo.id, repo])),
  useWorktreeMap: () =>
    new Map(
      Object.values(actionMocks.state.worktreesByRepo ?? {})
        .flat()
        .map((row) => [row.id, row])
    )
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }],
  AgentIcon: () => null
}))
afterEach(cleanup)
vi.mock('sonner', () => ({ toast: { error: actionMocks.error, message: vi.fn() } }))

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
  it.each([false, true])(
    'keeps the paired local workspace route local with a nested SSH repo twin, reversed=%s',
    (reverse) => {
      const repos = [
        makeRepo({ executionHostId: 'local' }),
        makeRepo({ executionHostId: 'ssh:box', connectionId: 'box' })
      ].map((repo) => adoptEndpointRepo({ kind: 'environment', environmentId: 'gpu' }, repo))
      if (reverse) {
        repos.reverse()
      }
      const row = withRepoHostOwnership(
        makeWorkspace({ id: 'repo-1::/repo', hostId: 'local' }),
        'runtime:gpu'
      )
      expect(
        resolveOwner(
          { repos, worktreesByRepo: { 'repo-1': [row] } },
          { workspaceId: row.id, hostId: 'runtime:gpu' }
        )
      ).toMatchObject({
        kind: 'resolved',
        owner: { endpoint: { kind: 'environment', environmentId: 'gpu' }, at: 'local' }
      })
    }
  )
  it.each([false, true])(
    'keeps endpoint local and nested SSH copied rows through actual catalog ingestion, reversed=%s',
    (reverse) => {
      const target = { kind: 'environment' as const, environmentId: 'gpu' }
      const repos = [
        makeRepo({ executionHostId: 'local' }),
        makeRepo({ executionHostId: 'ssh:box', connectionId: 'box' })
      ].map((repo) => adoptEndpointRepo(target, repo))
      const setups = [
        makeProjectHostSetup({ hostId: 'local' }),
        makeProjectHostSetup({ hostId: 'ssh:box', executionHostId: 'ssh:box' })
      ].map((setup) => adoptEndpointProjectHostSetup(target, setup))
      if (reverse) {
        repos.reverse()
        setups.reverse()
      }
      expect(mergeProjectHostSetupsByOwner([], setups)).toHaveLength(2)
      const merged = mergeFetchedReposForHost([], repos, 'runtime:gpu')
      expect(merged).toHaveLength(2)
      expect(merged.some((repo) => repo.connectionId === 'box')).toBe(true)
      expect(merged.some((repo) => !repo.connectionId)).toBe(true)
      const refreshed = mergeFetchedReposForHost(merged, structuredClone(repos), 'runtime:gpu')
      expect(refreshed).toBe(merged)
      const changed = repos.map((repo) =>
        repo.connectionId === 'box' ? { ...repo, displayName: 'Changed SSH' } : repo
      )
      const updated = mergeFetchedReposForHost(refreshed, changed, 'runtime:gpu')
      expect(updated.find((repo) => !repo.connectionId)).toBe(
        merged.find((repo) => !repo.connectionId)
      )
      expect(updated.find((repo) => repo.connectionId === 'box')?.displayName).toBe('Changed SSH')
    }
  )
  registerCapturedAutomationRunActionTests({
    actionMocks,
    makeAutomation,
    makeRepo,
    makeWorkspace,
    makeProjectHostSetup
  })

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

  it('blocks a saved run context that no longer matches the repo host setup', async () => {
    const availability = () =>
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
      })
    expect(availability().reason).toBe('host-mismatch')
    const originalLanguage = i18n.language
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    try {
      expect(availability()).toEqual({
        canRunNow: false,
        reason: 'host-mismatch',
        message: es.auto.components.automations.automationTargetAvailability.hostMismatch
      })
    } finally {
      await i18n.changeLanguage(originalLanguage)
    }
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
    // Keep the live repo matching so this isolates setup-side repoId checks after dropping derived projectId.
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

  it.each(['adopted', 'older-repo-projection'] as const)(
    'allows runtime-owned SSH using %s setup evidence and its server mirror',
    (shape) => {
      const target = { kind: 'environment' as const, environmentId: 'gpu' }
      const repo = adoptEndpointRepo(
        target,
        makeRepo({ executionHostId: 'ssh:devbox', connectionId: 'devbox' })
      )
      const setup =
        shape === 'adopted'
          ? adoptEndpointProjectHostSetup(
              target,
              makeProjectHostSetup({
                hostId: 'ssh:devbox',
                connectionId: 'devbox',
                executionHostId: 'ssh:devbox'
              })
            )
          : projectHostSetupProjectionFromRepos([repo]).setups[0]
      expect(
        getAutomationTargetAvailability({
          automation: makeAutomation({
            executionTargetType: 'ssh',
            executionTargetId: 'devbox',
            runContext: {
              kind: 'workspace-run',
              projectId: 'project-1',
              hostId: 'ssh:devbox',
              projectHostSetupId: setup.id,
              repoId: 'repo-1',
              path: '/repo'
            }
          }),
          repo,
          workspace: makeWorkspace(),
          projectHostSetups: [setup],
          sshConnectionStates: new Map([['devbox', { status: 'auth-failed' }]]),
          sshStateByEnvironment: new Map([
            [
              'gpu',
              {
                targetsHydrated: true,
                targetLabels: new Map(),
                targetGenerations: new Map(),
                removedTargetLabels: new Map(),
                connectionStates: new Map([
                  [
                    'devbox',
                    { targetId: 'devbox', status: 'connected', error: null, reconnectAttempt: 0 }
                  ]
                ])
              }
            ]
          ]),
          automationHostTarget: target
        })
      ).toEqual({ canRunNow: true, reason: 'available', message: null })
    }
  )

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

  it('matches the managed server setup when a moved SSH host keeps a setup with the same id', () => {
    // A legacy setup's id is its repo id, so the retained SSH source and its server share it.
    expect(
      getAutomationTargetAvailability({
        automation: makeAutomation({
          runContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'local',
            projectHostSetupId: 'repo-1',
            repoId: 'repo-1',
            path: '/repo'
          }
        }),
        repo: makeRepo({ executionHostId: 'runtime:gpu' }),
        workspace: makeWorkspace(),
        projectHostSetups: [
          makeProjectHostSetup({ id: 'repo-1', hostId: 'ssh:box', executionHostId: 'ssh:box' }),
          makeProjectHostSetup({
            id: 'repo-1',
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

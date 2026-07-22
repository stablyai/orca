import { describe, expect, it } from 'vitest'
import { getExecutionHostLabel, type ExecutionHostId } from '../../../shared/execution-host'
import type {
  ExecutionHostHealth,
  ExecutionHostRegistryEntry
} from '../../../shared/execution-host-registry'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { ProjectHostSetup, Repo } from '../../../shared/types'
import { buildProjectHostSetupOptions } from './project-host-setup-options'

const FULL_HOST_MODEL_RUNTIME_CAPABILITIES = [
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
]

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

function repo(id: string): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1
  }
}

function setup(
  id: string,
  projectId: string,
  hostId: ExecutionHostId,
  repoId: string,
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId,
    repoId,
    path: `/repos/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function host(
  id: ExecutionHostId,
  overrides: Partial<ExecutionHostRegistryEntry> = {}
): ExecutionHostRegistryEntry {
  return {
    id,
    kind: id === 'local' ? 'local' : id.startsWith('ssh:') ? 'ssh' : 'runtime',
    label: id === 'local' ? LOCAL_HOST_LABEL : id.replace(/^ssh:|^runtime:/, ''),
    detail: id === 'local' ? 'This computer' : 'Host',
    health: id === 'local' ? 'local' : 'available',
    ...overrides
  }
}

describe('buildProjectHostSetupOptions', () => {
  it('returns ready setup choices for one project sorted with local first', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo'), repo('remote-repo')],
      projectHostSetups: [
        setup('remote', 'project-1', 'ssh:builder', 'remote-repo'),
        setup('local', 'project-1', 'local', 'local-repo')
      ]
    })

    expect(options.map((option) => option.id)).toEqual(['local', 'remote'])
    expect(options[0]).toMatchObject({ label: LOCAL_HOST_LABEL, repoId: 'local-repo' })
    expect(options[1]).toMatchObject({ label: 'builder', repoId: 'remote-repo' })
  })

  it('uses saved host labels for ready runtime setup choices', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('runtime-repo')],
      hosts: [
        host('runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3', {
          label: 'dev box',
          capabilities: FULL_HOST_MODEL_RUNTIME_CAPABILITIES
        })
      ],
      projectHostSetups: [
        setup(
          'runtime',
          'project-1',
          'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3',
          'runtime-repo'
        )
      ]
    })

    expect(options).toEqual([
      expect.objectContaining({
        id: 'runtime',
        kind: 'ready',
        label: 'dev box',
        repoId: 'runtime-repo'
      })
    ])
  })

  it('omits ephemeral VM runtime setups from reusable project host choices', () => {
    const ephemeralHostId = 'runtime:90d880b2-de1b-44be-b7b8-8e15274e184e' as ExecutionHostId
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo'), repo('vm-repo')],
      hosts: [
        host('local'),
        host(ephemeralHostId, {
          label: '90d880b2-de1b-44be-b7b8-8e15274e184e',
          source: 'ephemeral-vm',
          capabilities: FULL_HOST_MODEL_RUNTIME_CAPABILITIES
        })
      ],
      projectHostSetups: [
        setup('local', 'project-1', 'local', 'local-repo'),
        setup('vm', 'project-1', ephemeralHostId, 'vm-repo', {
          path: '/vercel/sandbox/orca',
          displayName: 'orca'
        })
      ]
    })

    expect(options).toEqual([
      expect.objectContaining({ id: 'local', kind: 'ready', label: LOCAL_HOST_LABEL })
    ])
  })

  it('omits runtime-owned SSH (per-workspace-env) setups even when their host is filtered out', () => {
    // The execution-host registry filters runtime-owned targets, so the setup's host is absent
    // here — guard on the hostId so the hidden target never becomes a selectable run-target.
    const runtimeSshHostId = 'ssh:runtime-ssh-orca-e37aa3a9' as ExecutionHostId
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo'), repo('vm-repo')],
      hosts: [host('local')],
      projectHostSetups: [
        setup('local', 'project-1', 'local', 'local-repo'),
        setup('vm', 'project-1', runtimeSshHostId, 'vm-repo', {
          path: '/workspace/orca',
          displayName: 'orca'
        })
      ]
    })

    expect(options).toEqual([
      expect.objectContaining({ id: 'local', kind: 'ready', label: LOCAL_HOST_LABEL })
    ])
    expect(options.some((o) => String(o.hostId).includes('runtime-ssh-'))).toBe(false)
  })

  it('omits hidden host categories from setup-needed choices', () => {
    const runtimeSshHostId = 'ssh:runtime-ssh-orca-e37aa3a9' as ExecutionHostId
    const ephemeralHostId = 'runtime:90d880b2-de1b-44be-b7b8-8e15274e184e' as ExecutionHostId

    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [
        host('local'),
        host(runtimeSshHostId),
        host(ephemeralHostId, {
          source: 'ephemeral-vm',
          capabilities: FULL_HOST_MODEL_RUNTIME_CAPABILITIES
        })
      ],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options).toEqual([
      expect.objectContaining({ id: 'local', kind: 'ready', label: LOCAL_HOST_LABEL })
    ])
  })

  it('omits setups that are not ready or cannot create through an eligible repo', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('ready-repo')],
      projectHostSetups: [
        setup('ready', 'project-1', 'local', 'ready-repo'),
        setup('setting-up', 'project-1', 'ssh:builder', 'missing-repo', {
          setupState: 'setting-up'
        }),
        setup('other-project', 'project-2', 'local', 'ready-repo')
      ]
    })

    expect(options.map((option) => option.id)).toEqual(['ready'])
  })

  it('includes known hosts that still need project setup', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [host('local'), host('ssh:builder', { label: 'Builder' })],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options).toEqual([
      expect.objectContaining({ id: 'local', kind: 'ready', label: LOCAL_HOST_LABEL }),
      expect.objectContaining({
        id: 'needs-setup:ssh:builder',
        kind: 'needs-setup',
        label: 'Builder',
        detail: 'Project not set up on this host',
        isAvailable: true
      })
    ])
  })

  it.each([
    ['connecting' as const, 'Connecting to host'],
    ['disconnected' as const, 'Connect this host to set up projects'],
    ['error' as const, 'Host connection needs attention']
  ])(
    'marks %s hosts unavailable before project setup guidance',
    (health: ExecutionHostHealth, detail: string) => {
      const options = buildProjectHostSetupOptions({
        projectId: 'project-1',
        eligibleRepos: [repo('local-repo')],
        hosts: [host('local'), host('ssh:builder', { label: 'Builder', health })],
        projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
      })

      expect(options.at(-1)).toMatchObject({
        id: 'needs-setup:ssh:builder',
        kind: 'needs-setup',
        label: 'Builder',
        detail,
        isAvailable: false
      })
    }
  )

  it.each([
    ['connecting' as const, false],
    ['disconnected' as const, false],
    ['error' as const, true]
  ])('flags only errored %s hosts for attention', (health: ExecutionHostHealth, attention) => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [host('local'), host('ssh:builder', { label: 'Builder', health })],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options.at(-1)).toMatchObject({ kind: 'needs-setup', attention })
  })

  it.each([
    ['ssh:builder' as const, { kind: 'ssh', targetId: 'builder' }],
    ['runtime:gpu' as const, { kind: 'runtime', environmentId: 'gpu' }]
  ])('adds a connect action for disconnected %s setup-needed hosts', (hostId, connectAction) => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [
        host('local'),
        host(hostId, {
          label: 'Builder',
          health: 'disconnected'
        })
      ],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options.at(-1)).toMatchObject({
      id: `needs-setup:${hostId}`,
      kind: 'needs-setup',
      connectAction
    })
  })

  it('adds a connect action for errored setup-needed hosts', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [
        host('local'),
        host('ssh:builder', {
          label: 'Builder',
          health: 'error'
        })
      ],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options.at(-1)).toMatchObject({
      id: 'needs-setup:ssh:builder',
      kind: 'needs-setup',
      connectAction: { kind: 'ssh', targetId: 'builder' }
    })
  })

  it.each(['available' as const, 'connecting' as const, 'blocked' as const])(
    'does not add a connect action for %s setup-needed hosts',
    (health) => {
      const options = buildProjectHostSetupOptions({
        projectId: 'project-1',
        eligibleRepos: [repo('local-repo')],
        hosts: [
          host('local'),
          host('ssh:builder', {
            label: 'Builder',
            health
          })
        ],
        projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
      })

      expect(options.at(-1)).not.toHaveProperty('connectAction')
    }
  )

  it('shows pending setup status for known hosts with non-ready setup metadata', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [
        host('local'),
        host('runtime:gpu', {
          label: 'GPU VM',
          capabilities: FULL_HOST_MODEL_RUNTIME_CAPABILITIES
        })
      ],
      projectHostSetups: [
        setup('local', 'project-1', 'local', 'local-repo'),
        setup('gpu-pending', 'project-1', 'runtime:gpu', '', {
          path: '',
          setupState: 'setting-up',
          setupMethod: 'provisioned'
        })
      ]
    })

    expect(options).toEqual([
      expect.objectContaining({ id: 'local', kind: 'ready', label: LOCAL_HOST_LABEL }),
      expect.objectContaining({
        id: 'needs-setup:runtime:gpu',
        kind: 'needs-setup',
        label: 'GPU VM',
        detail: 'Project setup is in progress',
        isAvailable: true
      })
    ])
  })

  it('uses specific pending details for not-set-up, error, and unsupported setup metadata', () => {
    const base = {
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    }

    expect(
      buildProjectHostSetupOptions({
        ...base,
        hosts: [
          host('runtime:gpu', {
            label: 'GPU VM',
            capabilities: FULL_HOST_MODEL_RUNTIME_CAPABILITIES
          })
        ],
        projectHostSetups: [
          ...base.projectHostSetups,
          setup('gpu-pending', 'project-1', 'runtime:gpu', '', {
            path: '',
            setupState: 'not-set-up',
            setupMethod: 'provisioned'
          })
        ]
      }).at(-1)
    ).toMatchObject({ detail: 'Project tracked on this host but not set up' })

    expect(
      buildProjectHostSetupOptions({
        ...base,
        hosts: [
          host('runtime:gpu', {
            label: 'GPU VM',
            capabilities: FULL_HOST_MODEL_RUNTIME_CAPABILITIES
          })
        ],
        projectHostSetups: [
          ...base.projectHostSetups,
          setup('gpu-pending', 'project-1', 'runtime:gpu', '', {
            path: '',
            setupState: 'error',
            setupMethod: 'provisioned'
          })
        ]
      }).at(-1)
    ).toMatchObject({ detail: 'Project setup needs attention' })

    expect(
      buildProjectHostSetupOptions({
        ...base,
        hosts: [
          host('runtime:gpu', {
            label: 'GPU VM',
            capabilities: FULL_HOST_MODEL_RUNTIME_CAPABILITIES
          })
        ],
        projectHostSetups: [
          ...base.projectHostSetups,
          setup('gpu-pending', 'project-1', 'runtime:gpu', '', {
            path: '',
            setupState: 'unsupported',
            setupMethod: 'provisioned'
          })
        ]
      }).at(-1)
    ).toMatchObject({ detail: 'Project is unsupported on this host' })
  })

  it('marks incompatible runtime hosts as visible but unavailable', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [
        host('local'),
        host('runtime:gpu', {
          label: 'GPU VM',
          health: 'blocked',
          capabilities: FULL_HOST_MODEL_RUNTIME_CAPABILITIES
        })
      ],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options).toEqual([
      expect.objectContaining({ id: 'local', kind: 'ready', label: LOCAL_HOST_LABEL }),
      expect.objectContaining({
        id: 'needs-setup:runtime:gpu',
        kind: 'needs-setup',
        label: 'GPU VM',
        detail: 'Orca server version is incompatible',
        isAvailable: false
      })
    ])
  })

  it('marks runtime hosts without project setup capability as unavailable', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [host('local'), host('runtime:gpu', { label: 'GPU VM', capabilities: [] })],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options.at(-1)).toMatchObject({
      id: 'needs-setup:runtime:gpu',
      kind: 'needs-setup',
      detail: 'Update Orca on this host to set up projects',
      isAvailable: false
    })
  })

  it('marks runtime hosts without workspace run-context capability as unavailable', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [
        host('local'),
        host('runtime:gpu', {
          label: 'GPU VM',
          capabilities: [PROJECT_HOST_SETUP_RUNTIME_CAPABILITY]
        })
      ],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options.at(-1)).toMatchObject({
      id: 'needs-setup:runtime:gpu',
      kind: 'needs-setup',
      detail: 'Update Orca on this host to set up projects',
      isAvailable: false
    })
  })

  it('marks runtime hosts with unknown capabilities as unavailable while checking', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo')],
      hosts: [host('local'), host('runtime:gpu', { label: 'GPU VM' })],
      projectHostSetups: [setup('local', 'project-1', 'local', 'local-repo')]
    })

    expect(options.at(-1)).toMatchObject({
      id: 'needs-setup:runtime:gpu',
      kind: 'needs-setup',
      detail: 'Checking host capabilities',
      isAvailable: false
    })
  })
})

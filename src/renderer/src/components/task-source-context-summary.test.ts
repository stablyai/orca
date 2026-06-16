import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../shared/execution-host'
import {
  getTaskSourceAvailabilityNotice,
  getTaskSourceContextSummary
} from './task-source-context-summary'

const localHostLabel = getLocalExecutionHostLabel()

describe('task source context summary', () => {
  it('shows provider, host, and provider identity for a single repo-backed source', () => {
    const summary = getTaskSourceContextSummary({
      provider: 'github',
      providerLabel: 'GitHub',
      selectedRepoCount: 1,
      repoContexts: [
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:devbox',
          projectHostSetupId: 'setup-1',
          repoId: 'repo-1',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
        }
      ]
    })

    expect(summary.label).toBe('GitHub · devbox · stablyai/orca')
    expect(summary.title).toBe('GitHub · Host: devbox · Source: stablyai/orca')
  })

  it('shows repo-backed provider account labels when accounts can differ by host', () => {
    const summary = getTaskSourceContextSummary({
      provider: 'github',
      providerLabel: 'GitHub',
      selectedRepoCount: 2,
      repoContexts: [
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:stablyai/orca',
          hostId: 'local',
          projectHostSetupId: 'setup-local',
          repoId: 'repo-local',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
          accountLabel: 'personal-gh'
        },
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:builder',
          projectHostSetupId: 'setup-builder',
          repoId: 'repo-builder',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
          accountLabel: 'work-gh'
        }
      ]
    })

    expect(summary.label).toBe(`GitHub · ${localHostLabel}, builder · personal-gh, work-gh`)
    expect(summary.title).toBe(
      `GitHub · Host: ${localHostLabel}, builder · Account: personal-gh, work-gh · Source: stablyai/orca · 2 selected projects`
    )
  })

  it('shows disconnected source-host availability for a single SSH repo source', () => {
    const summary = getTaskSourceContextSummary({
      provider: 'github',
      providerLabel: 'GitHub',
      selectedRepoCount: 1,
      repoContexts: [
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:devbox',
          repoId: 'repo-1',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
        }
      ],
      hostAvailability: [{ hostId: 'ssh:devbox', status: 'disconnected' }]
    })

    expect(summary.label).toBe('GitHub · devbox · disconnected · stablyai/orca')
    expect(summary.title).toBe(
      'GitHub · Host: devbox · Availability: devbox disconnected · Source: stablyai/orca'
    )
  })

  it('summarizes multiple unavailable source hosts without cluttering the label', () => {
    const summary = getTaskSourceContextSummary({
      provider: 'github',
      providerLabel: 'GitHub',
      selectedRepoCount: 2,
      repoContexts: [
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-a',
          hostId: 'ssh:devbox',
          repoId: 'repo-a'
        },
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-b',
          hostId: 'ssh:buildbox',
          repoId: 'repo-b'
        }
      ],
      hostAvailability: [
        { hostId: 'ssh:devbox', status: 'auth-failed' },
        { hostId: 'ssh:buildbox', status: 'reconnecting' }
      ]
    })

    expect(summary.label).toBe('GitHub · devbox, buildbox · 2 unavailable · 2 projects')
    expect(summary.title).toBe(
      'GitHub · Host: devbox, buildbox · Availability: devbox auth needed, buildbox connecting · 2 selected projects'
    )
  })

  it('summarizes multiple repo-backed hosts without hiding the selected count', () => {
    const summary = getTaskSourceContextSummary({
      provider: 'gitlab',
      providerLabel: 'GitLab',
      selectedRepoCount: 3,
      repoContexts: [
        {
          kind: 'task-source',
          provider: 'gitlab',
          projectId: 'project-a',
          hostId: 'local',
          repoId: 'repo-a'
        },
        {
          kind: 'task-source',
          provider: 'gitlab',
          projectId: 'project-b',
          hostId: 'ssh:build',
          repoId: 'repo-b'
        },
        {
          kind: 'task-source',
          provider: 'gitlab',
          projectId: 'project-c',
          hostId: 'runtime:linux',
          repoId: 'repo-c'
        }
      ]
    })

    expect(summary.label).toBe(`GitLab · ${localHostLabel} +2 · 3 projects`)
    expect(summary.title).toBe(
      `GitLab · Host: ${localHostLabel}, build, linux · 3 selected projects`
    )
  })

  it('shows blocked remote-server source-host availability', () => {
    const summary = getTaskSourceContextSummary({
      provider: 'github',
      providerLabel: 'GitHub',
      selectedRepoCount: 1,
      repoContexts: [
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-a',
          hostId: 'runtime:old-server',
          repoId: 'repo-a',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
        }
      ],
      hostAvailability: [{ hostId: 'runtime:old-server', health: 'blocked' }]
    })

    expect(summary.label).toBe('GitHub · old-server · server update needed · stablyai/orca')
    expect(summary.title).toBe(
      'GitHub · Host: old-server · Availability: old-server server update needed · Source: stablyai/orca'
    )
  })

  it('shows remote-server task-source capability checks', () => {
    const summary = getTaskSourceContextSummary({
      provider: 'github',
      providerLabel: 'GitHub',
      selectedRepoCount: 1,
      repoContexts: [
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-a',
          hostId: 'runtime:old-server',
          repoId: 'repo-a',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
        }
      ],
      hostAvailability: [
        { hostId: 'runtime:old-server', reason: 'checking-task-source-capability' }
      ]
    })

    expect(summary.label).toBe('GitHub · old-server · checking server capabilities · stablyai/orca')
    expect(summary.title).toBe(
      'GitHub · Host: old-server · Availability: old-server checking server capabilities · Source: stablyai/orca'
    )
  })

  it('uses saved remote server labels in repo-backed source summaries and notices', () => {
    const hostLabelById = new Map([['runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3', 'dev box']])

    expect(
      getTaskSourceContextSummary({
        provider: 'github',
        providerLabel: 'GitHub',
        selectedRepoCount: 1,
        hostLabelById,
        repoContexts: [
          {
            kind: 'task-source',
            provider: 'github',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3',
            repoId: 'repo-runtime',
            providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
          }
        ],
        hostAvailability: [
          {
            hostId: 'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3',
            health: 'blocked'
          }
        ]
      })
    ).toEqual({
      label: 'GitHub · dev box · server update needed · stablyai/orca',
      title:
        'GitHub · Host: dev box · Availability: dev box server update needed · Source: stablyai/orca'
    })

    expect(
      getTaskSourceAvailabilityNotice({
        providerLabel: 'GitHub',
        sourceCount: 1,
        hostLabelById,
        hostAvailability: [
          {
            hostId: 'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3',
            reason: 'missing-task-source-capability'
          }
        ]
      })?.label
    ).toBe('GitHub source unavailable: dev box server update needed for task sources')
  })

  it('shows remote-server task-source capability version skew', () => {
    expect(
      getTaskSourceAvailabilityNotice({
        providerLabel: 'GitHub',
        sourceCount: 1,
        hostAvailability: [
          { hostId: 'runtime:old-server', reason: 'missing-task-source-capability' }
        ]
      })
    ).toEqual({
      label: 'GitHub source unavailable: old-server server update needed for task sources',
      title:
        'Reconnect or update old-server server update needed for task sources to load this source.',
      blocking: true
    })
  })

  it('shows account-backed Linear and Jira sources', () => {
    expect(
      getTaskSourceContextSummary({
        provider: 'linear',
        providerLabel: 'Linear',
        accountHostId: 'local',
        linearWorkspaceName: 'Stably'
      }).label
    ).toBe(`Linear · ${localHostLabel} · Stably`)

    expect(
      getTaskSourceContextSummary({
        provider: 'jira',
        providerLabel: 'Jira',
        accountHostId: 'runtime:server',
        jiraSiteName: 'Stably Jira'
      }).label
    ).toBe('Jira · server · Stably Jira')
  })

  it('shows account-backed source host availability', () => {
    const summary = getTaskSourceContextSummary({
      provider: 'linear',
      providerLabel: 'Linear',
      accountHostId: 'runtime:old-server',
      linearWorkspaceName: 'Stably',
      hostAvailability: [{ hostId: 'runtime:old-server', health: 'blocked' }]
    })

    expect(summary.label).toBe('Linear · old-server · server update needed · Stably')
    expect(summary.title).toBe(
      'Linear source · Host: old-server · Availability: old-server server update needed · Account: Stably'
    )
  })

  it('builds a visible unavailable-source notice from host availability', () => {
    expect(
      getTaskSourceAvailabilityNotice({
        providerLabel: 'GitHub',
        hostAvailability: [{ hostId: 'ssh:devbox', status: 'auth-failed' }]
      })
    ).toEqual({
      label: 'GitHub source unavailable: devbox auth needed',
      title: 'Reconnect or update devbox auth needed to load this source.',
      blocking: true
    })

    expect(
      getTaskSourceAvailabilityNotice({
        providerLabel: 'GitLab',
        sourceCount: 3,
        hostAvailability: [
          { hostId: 'ssh:devbox', status: 'disconnected' },
          { hostId: 'runtime:old-server', health: 'blocked' }
        ]
      })?.label
    ).toBe('Some GitLab source hosts unavailable: 2 source hosts')
  })

  it('shows provider-specific source availability reasons', () => {
    expect(
      getTaskSourceContextSummary({
        provider: 'github',
        providerLabel: 'GitHub',
        selectedRepoCount: 1,
        repoContexts: [
          {
            kind: 'task-source',
            provider: 'github',
            projectId: 'github:stablyai/orca',
            hostId: 'ssh:devbox',
            repoId: 'repo-1',
            providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
          }
        ],
        hostAvailability: [{ hostId: 'ssh:devbox', reason: 'missing-provider-auth' }]
      })
    ).toEqual({
      label: 'GitHub · devbox · provider auth needed · stablyai/orca',
      title:
        'GitHub · Host: devbox · Availability: devbox provider auth needed · Source: stablyai/orca'
    })

    expect(
      getTaskSourceAvailabilityNotice({
        providerLabel: 'GitHub',
        sourceCount: 3,
        hostAvailability: [
          { hostId: 'ssh:devbox', reason: 'unavailable-source-tool' },
          { hostId: 'runtime:linux', reason: 'unsupported-provider' }
        ]
      })
    ).toEqual({
      label: 'Some GitHub source hosts unavailable: 2 source hosts',
      title:
        'Reconnect or update devbox source tool unavailable, linux provider unsupported on this host to load this source.',
      blocking: false
    })
  })
})

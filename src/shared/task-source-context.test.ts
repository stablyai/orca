import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'
import {
  buildTaskSourceContextFromRepo,
  buildWorkspaceRunContext,
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  normalizeTaskSourceContext,
  runtimeHostIdFromEnvironmentId
} from './task-source-context'

describe('task source context', () => {
  it('defaults source context to the local host', () => {
    expect(
      normalizeTaskSourceContext({
        provider: 'github',
        projectId: ' project-1 ',
        providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
      })
    ).toEqual({
      kind: 'task-source',
      provider: 'github',
      projectId: 'project-1',
      hostId: 'local',
      projectHostSetupId: null,
      repoId: null,
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
      accountLabel: null
    })
  })

  it('uses repo execution ownership when building a source context', () => {
    expect(
      buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: 'project-1',
        repo: {
          id: 'repo-1',
          connectionId: 'ssh target',
          executionHostId: null
        }
      })?.hostId
    ).toBe(toSshExecutionHostId('ssh target'))

    expect(
      buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: 'project-1',
        repo: {
          id: 'repo-1',
          connectionId: 'ssh target',
          executionHostId: toRuntimeExecutionHostId('remote-runtime')
        }
      })?.hostId
    ).toBe(toRuntimeExecutionHostId('remote-runtime'))
  })

  it('derives runtime settings only for runtime-owned task sources', () => {
    expect(
      getTaskSourceRuntimeSettings({
        hostId: toRuntimeExecutionHostId('remote-runtime')
      })
    ).toEqual({ activeRuntimeEnvironmentId: 'remote-runtime' })

    expect(
      getTaskSourceRuntimeSettings({
        hostId: toSshExecutionHostId('ssh-target')
      })
    ).toEqual({ activeRuntimeEnvironmentId: null })
  })

  it('keeps provider cache scopes separate by host and provider identity', () => {
    const local = getTaskSourceCacheScope({
      provider: 'github',
      projectId: 'project-1',
      hostId: 'local',
      repoId: 'repo-1',
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
    const ssh = getTaskSourceCacheScope({
      provider: 'github',
      projectId: 'project-1',
      hostId: toSshExecutionHostId('builder'),
      repoId: 'repo-1',
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
    const differentRepo = getTaskSourceCacheScope({
      provider: 'github',
      projectId: 'project-1',
      hostId: 'local',
      repoId: 'repo-1',
      providerIdentity: { provider: 'github', owner: 'other', repo: 'orca' }
    })

    expect(local).not.toBe(ssh)
    expect(local).not.toBe(differentRepo)
  })

  it('serializes provider identities for GitLab, Linear, and Jira cache scopes', () => {
    const base = {
      projectId: 'project-1',
      hostId: LOCAL_EXECUTION_HOST_ID,
      repoId: 'repo-1'
    } as const

    expect(
      getTaskSourceCacheScope({
        ...base,
        provider: 'gitlab',
        providerIdentity: { provider: 'gitlab', namespace: 'stably', project: 'orca' }
      })
    ).toContain(encodeURIComponent('stably/orca'))
    expect(
      getTaskSourceCacheScope({
        ...base,
        provider: 'linear',
        providerIdentity: { provider: 'linear', workspaceId: 'workspace-1', teamKey: 'ENG' }
      })
    ).toContain(encodeURIComponent('workspace-1/ENG'))
    expect(
      getTaskSourceCacheScope({
        ...base,
        provider: 'jira',
        providerIdentity: {
          provider: 'jira',
          siteUrl: 'https://example.atlassian.net',
          projectKey: 'OPS'
        }
      })
    ).toContain(encodeURIComponent('https://example.atlassian.net/OPS'))
  })

  it('drops provider identities that do not match the source provider', () => {
    expect(
      normalizeTaskSourceContext({
        provider: 'gitlab',
        projectId: 'project-1',
        providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
      })?.providerIdentity
    ).toBeNull()
  })

  it('builds workspace run context from an explicit project host setup', () => {
    expect(
      buildWorkspaceRunContext({
        projectId: 'project-1',
        hostId: toSshExecutionHostId('builder'),
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      })
    ).toEqual({
      kind: 'workspace-run',
      projectId: 'project-1',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'setup-1',
      repoId: 'repo-1',
      path: '/repo'
    })
  })

  it('normalizes focused runtime ids to host ids', () => {
    expect(runtimeHostIdFromEnvironmentId(' remote ')).toBe(toRuntimeExecutionHostId('remote'))
    expect(runtimeHostIdFromEnvironmentId(' ')).toBe('local')
  })
})

import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'
import {
  areTaskSourceContextsEqual,
  buildTaskSourceContextFromRepo,
  buildWorkspaceRunContext,
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  normalizeStoredTaskSourceContext,
  normalizeTaskSourceContext,
  runtimeHostIdFromEnvironmentId,
  type TaskSourceContext
} from './task-source-context'
import { TaskSourceContextSchema } from './task-source-context-schema'

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
    const enterpriseRepo = getTaskSourceCacheScope({
      provider: 'github',
      projectId: 'project-1',
      hostId: 'local',
      repoId: 'repo-1',
      providerIdentity: {
        provider: 'github',
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.acme.test'
      }
    })

    expect(local).not.toBe(ssh)
    expect(local).not.toBe(differentRepo)
    expect(local).not.toBe(enterpriseRepo)
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

  it('rejects malformed stored scalar and provider-identity fields without throwing', () => {
    const valid = {
      kind: 'task-source',
      provider: 'jira',
      projectId: 'project-1',
      hostId: 'local',
      providerIdentity: {
        provider: 'jira',
        siteId: 'site-1',
        siteUrl: 'https://example.atlassian.net',
        projectKey: 'OPS'
      }
    }
    for (const malformed of [
      { ...valid, accountLabel: 44 },
      { ...valid, hostId: { runtime: 'env-1' } },
      { ...valid, providerIdentity: { ...valid.providerIdentity, siteId: 44 } },
      { ...valid, providerIdentity: { ...valid.providerIdentity, projectKey: [] } }
    ]) {
      expect(() => TaskSourceContextSchema.safeParse(malformed)).not.toThrow()
      expect(TaskSourceContextSchema.safeParse(malformed).success).toBe(false)
      expect(normalizeStoredTaskSourceContext(malformed)).toBeNull()
    }
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

describe('areTaskSourceContextsEqual', () => {
  const base: TaskSourceContext = {
    kind: 'task-source',
    provider: 'jira',
    projectId: 'project-1',
    hostId: 'local',
    repoId: 'repo-1',
    providerIdentity: {
      provider: 'jira',
      siteId: 'site-1',
      siteUrl: 'https://company.atlassian.net',
      projectKey: 'ORCA'
    }
  }

  it('ignores key order and absent-vs-null optional fields', () => {
    expect(
      areTaskSourceContextsEqual(base, {
        providerIdentity: {
          projectKey: 'ORCA',
          siteUrl: 'https://company.atlassian.net',
          siteId: 'site-1',
          provider: 'jira'
        },
        repoId: 'repo-1',
        hostId: 'local',
        projectId: 'project-1',
        provider: 'jira',
        kind: 'task-source',
        accountLabel: null
      })
    ).toBe(true)
  })

  it('treats both nullish contexts as equal and a one-sided context as different', () => {
    expect(areTaskSourceContextsEqual(null, undefined)).toBe(true)
    expect(areTaskSourceContextsEqual(base, null)).toBe(false)
  })

  it('separates contexts that differ by host, account, or provider identity', () => {
    expect(areTaskSourceContextsEqual(base, { ...base, hostId: 'ssh:builder' })).toBe(false)
    expect(areTaskSourceContextsEqual(base, { ...base, accountLabel: 'ada@example.com' })).toBe(
      false
    )
    expect(
      areTaskSourceContextsEqual(base, {
        ...base,
        providerIdentity: { provider: 'jira', siteId: 'site-2' }
      })
    ).toBe(false)
    expect(areTaskSourceContextsEqual(base, { ...base, providerIdentity: null })).toBe(false)
  })

  it('does not equate identities from different providers', () => {
    const github: TaskSourceContext = {
      ...base,
      provider: 'github',
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'orca' }
    }
    expect(areTaskSourceContextsEqual(github, { ...github, provider: 'gitlab' })).toBe(false)
  })
})

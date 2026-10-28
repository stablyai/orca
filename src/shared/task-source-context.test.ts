import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from './execution-host'
import {
  areTaskSourceContextsEqual,
  buildTaskSourceContextFromRepo,
  getTaskSourceCacheScope,
  normalizeStoredTaskSourceContext,
  normalizeTaskSourceContext,
  type TaskSourceContext
} from './task-source-context'
import { TaskSourceContextSchema } from './task-source-context-schema'

describe('task source context', () => {
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

  it('separates named task accounts without changing legacy anonymous cache scopes', () => {
    const source = { provider: 'linear', projectId: 'project', hostId: 'runtime:owner' } as const
    const legacy = getTaskSourceCacheScope(source)
    expect(getTaskSourceCacheScope({ ...source, accountLabel: null })).toBe(legacy)
    expect(getTaskSourceCacheScope({ ...source, accountLabel: ' account-a ' })).toBe(
      getTaskSourceCacheScope({ ...source, accountLabel: 'account-a' })
    )
    const account = getTaskSourceCacheScope({ ...source, accountLabel: 'account-a' })
    expect(account).not.toBe(legacy)
    expect(account).not.toBe(getTaskSourceCacheScope({ ...source, accountLabel: 'account-b' }))
    expect(account).not.toBe(
      getTaskSourceCacheScope({ ...source, hostId: 'local', accountLabel: 'account-a' })
    )
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
})

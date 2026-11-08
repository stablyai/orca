import { describe, expect, it } from 'vitest'

import {
  areTaskSourceContextsEqual,
  normalizeStoredTaskSourceContext,
  normalizeTaskSourceContext,
  type TaskSourceContext
} from './task-source-context'
import { TaskSourceContextSchema } from './task-source-context-schema'

describe('task source context', () => {
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

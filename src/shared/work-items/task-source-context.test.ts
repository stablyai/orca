import { describe, expect, it } from 'vitest'

import { areTaskSourceContextsEqual, type TaskSourceContext } from './task-source-context'

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

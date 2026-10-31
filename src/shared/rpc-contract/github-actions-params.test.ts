import { describe, expect, it } from 'vitest'
import { ActionsRuns, ActionsWorkflows, ActionsRunDetails } from './github-actions-params'

describe('Actions RPC contracts', () => {
  it('retains Enterprise identity and optional attempt ownership', () => {
    expect(
      ActionsRunDetails.parse({
        repo: 'repo-id',
        repository: { owner: 'acme', repo: 'widgets', host: 'enterprise.example' },
        runId: 9,
        jobsPage: 2,
        expectedAttempt: 3,
        noCache: true
      })
    ).toMatchObject({ repository: { host: 'enterprise.example' }, expectedAttempt: 3, jobsPage: 2 })
  })
  it('rejects unbounded pagination and invalid IDs before a host handler can execute', () => {
    expect(ActionsRuns.safeParse({ repo: 'repo-id', page: 21 }).success).toBe(false)
    expect(ActionsRuns.safeParse({ repo: 'repo-id', workflowId: 0 }).success).toBe(false)
    expect(ActionsWorkflows.safeParse({ repo: 'repo-id', page: 11 }).success).toBe(false)
    expect(
      ActionsRunDetails.safeParse({
        repo: 'repo-id',
        repository: { owner: 'a', repo: 'r' },
        runId: -1
      }).success
    ).toBe(false)
  })
})

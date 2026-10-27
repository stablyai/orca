import { describe, expect, it } from 'vitest'
import { buildCheckRunDetailsTabId, getCheckRunTabIdentity } from './check-run-details-tab'

describe('check-run-details-tab', () => {
  it('falls back to workflow and url identities when check run id is missing', () => {
    expect(
      getCheckRunTabIdentity({
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://github.com/acme/widgets/actions/runs/1',
        workflowRunId: 12
      })
    ).toBe('workflow-run:12')
    expect(
      getCheckRunTabIdentity({
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://github.com/acme/widgets/actions/runs/1'
      })
    ).toBe('url:https://github.com/acme/widgets/actions/runs/1')
  })

  it('keys GitLab jobs by job id so same-named stages do not share one tab', () => {
    const base = { status: 'completed', conclusion: 'failure', url: null } as const

    expect(getCheckRunTabIdentity({ ...base, name: 'test: unit', gitlabJobId: 42 })).toBe(
      'gitlab-job:42'
    )
    expect(
      buildCheckRunDetailsTabId('wt-1', { ...base, name: 'test: unit', gitlabJobId: 42 })
    ).not.toBe(buildCheckRunDetailsTabId('wt-1', { ...base, name: 'test: unit', gitlabJobId: 43 }))
  })
})

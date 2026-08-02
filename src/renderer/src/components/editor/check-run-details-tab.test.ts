import { describe, expect, it } from 'vitest'
import {
  buildCheckRunDetailsTabId,
  getCheckRunDetailsTabLabel,
  getCheckRunTabIdentity
} from './check-run-details-tab'

describe('check-run-details-tab', () => {
  it('builds a stable tab id from worktree and check identity', () => {
    expect(
      buildCheckRunDetailsTabId('wt-1', {
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: null,
        checkRunId: 99
      })
    ).toBe('wt-1::check-details::check-run:99')
  })

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

  it('uses the check name for the tab label', () => {
    expect(
      getCheckRunDetailsTabLabel({
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: null
      })
    ).toBe('verify')
  })
})

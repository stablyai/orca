import { describe, expect, it } from 'vitest'
import type { ExternalAutomationManager } from '../../../../shared/automations-types'
import { buildExternalAutomationListEntries } from './external-automation-list-entries'

function manager(overrides: Partial<ExternalAutomationManager> = {}): ExternalAutomationManager {
  return {
    id: 'hermes:ssh:openclaw',
    provider: 'hermes',
    label: 'Hermes on openclaw',
    targetLabel: 'openclaw',
    target: { type: 'ssh', connectionId: 'openclaw' },
    status: 'unavailable',
    error: 'SSH target is not connected.',
    canManage: false,
    jobs: [],
    ...overrides
  }
}

describe('buildExternalAutomationListEntries', () => {
  it('omits empty host probes', () => {
    expect(buildExternalAutomationListEntries([manager()])).toEqual([])
  })

  it('lists jobs from an unavailable manager', () => {
    expect(
      buildExternalAutomationListEntries([
        manager({
          jobs: [
            {
              id: 'job-1',
              managerId: 'hermes:ssh:openclaw',
              provider: 'hermes',
              name: 'Nightly',
              schedule: '0 9 * * *',
              rawSchedule: '0 9 * * *',
              enabled: true,
              state: 'active',
              prompt: 'do work',
              promptPreview: 'do work',
              nextRunAt: null,
              lastRunAt: null,
              lastStatus: null,
              lastError: null,
              workdir: null,
              runCount: 1,
              runs: []
            }
          ]
        })
      ])
    ).toEqual([
      expect.objectContaining({
        job: expect.objectContaining({ id: 'job-1' })
      })
    ])
  })
})

import { describe, expect, it } from 'vitest'
import type { ExternalAutomationManager } from '../../../../shared/automations-types'
import { buildExternalAutomationListEntries } from './external-automation-list-entries'
import type { ScopedExternalAutomationManager } from './external-automation-scope-client'

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

function job(id = 'job-1'): ExternalAutomationManager['jobs'][number] {
  return {
    id,
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
}

function scoped(
  environmentId: string | null,
  overrides: Partial<ExternalAutomationManager> = {}
): ScopedExternalAutomationManager {
  return {
    scope: {
      owner: {
        authority:
          environmentId === null
            ? { kind: 'desktop' }
            : { kind: 'runtime', environmentId, pairingRevision: 1 },
        selector: { kind: 'self' }
      },
      provider: 'hermes'
    },
    manager: manager(overrides)
  }
}

describe('buildExternalAutomationListEntries', () => {
  it('omits empty host probes', () => {
    expect(buildExternalAutomationListEntries([scoped(null)])).toEqual([])
  })

  it('lists jobs from an unavailable manager', () => {
    expect(buildExternalAutomationListEntries([scoped(null, { jobs: [job()] })])).toEqual([
      expect.objectContaining({
        job: expect.objectContaining({ id: 'job-1' })
      })
    ])
  })

  it('separates identical manager and job IDs reported by two authorities', () => {
    // `hermes:local` names no authority, so both hosts hand back the same manager
    // ID. An unqualified key would make the two rows one, and the second would
    // shadow the first in selection, dialogs, and React's reconciliation.
    const entries = buildExternalAutomationListEntries([
      scoped(null, { id: 'hermes:local', target: { type: 'local' }, jobs: [job()] }),
      scoped('env-7', { id: 'hermes:local', target: { type: 'local' }, jobs: [job()] })
    ])

    expect(entries).toHaveLength(2)
    expect(entries[0]?.key).not.toBe(entries[1]?.key)
  })

  it('carries the scope it keyed each entry with', () => {
    const [entry] = buildExternalAutomationListEntries([scoped('env-7', { jobs: [job()] })])

    // The entry is what the edit dialog captures; re-deriving the scope from the
    // manager ID at save time is the lookup this field exists to avoid.
    expect(entry?.scope.owner.authority).toEqual({
      kind: 'runtime',
      environmentId: 'env-7',
      pairingRevision: 1
    })
  })
})

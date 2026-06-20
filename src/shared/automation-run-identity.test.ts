import { describe, expect, it } from 'vitest'
import type { Automation } from './automations-types'
import {
  getAutomationLegacyRepoId,
  getAutomationRunProjectId,
  getAutomationRunRepoId
} from './automation-run-identity'

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Automation',
    prompt: 'Run this',
    precheck: null,
    agentId: 'claude',
    runContext: null,
    sourceContext: null,
    projectId: 'legacy-repo',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('automation run identity', () => {
  it('uses explicit run context identity when present', () => {
    const value = automation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:builder',
        projectHostSetupId: 'setup-builder',
        repoId: 'remote-repo',
        path: '/remote/orca'
      }
    })

    expect(getAutomationLegacyRepoId(value)).toBe('legacy-repo')
    expect(getAutomationRunRepoId(value)).toBe('remote-repo')
    expect(getAutomationRunProjectId(value)).toBe('github:stablyai/orca')
  })

  it('falls back to the legacy repo id for pre-host-context automations', () => {
    const value = automation()

    expect(getAutomationLegacyRepoId(value)).toBe('legacy-repo')
    expect(getAutomationRunRepoId(value)).toBe('legacy-repo')
    expect(getAutomationRunProjectId(value)).toBe('legacy-repo')
  })
})

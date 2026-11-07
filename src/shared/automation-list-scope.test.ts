import { describe, expect, it } from 'vitest'
import type { Automation } from './automations-types'
import {
  AUTOMATION_ORPHAN_ISSUES,
  automationSelectorMatchesScope,
  projectAutomationSelector,
  type AutomationProjectionContext
} from './automation-list-scope'
function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as Automation
}

function context(
  overrides: Partial<AutomationProjectionContext> = {}
): AutomationProjectionContext {
  return {
    sshTargetGeneration: (targetId) => (targetId === 'ssh-1' ? 7 : undefined),
    repoConnectionId: (repoId) =>
      repoId === 'repo-1' ? null : repoId === 'repo-ssh' ? 'ssh-1' : undefined,
    ...overrides
  }
}

describe('projectAutomationSelector', () => {
  it('orphans an SSH record whose target was removed and re-added', () => {
    const record = automation({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1',
      executionTargetGeneration: 5
    })
    expect(projectAutomationSelector(record, context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced
    })
  })

  it('orphans an SSH record whose target is gone', () => {
    const record = automation({ executionTargetType: 'ssh', executionTargetId: 'ssh-gone' })
    expect(projectAutomationSelector(record, context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetMissing
    })
  })

  it('never assigns a runtime-scheduled record to another authority', () => {
    const record = automation({ schedulerOwner: 'remote_host_service' })
    expect(projectAutomationSelector(record, context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.scheduledElsewhere
    })
    const byHostId = automation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'p',
        hostId: 'runtime:env-1',
        projectHostSetupId: 's',
        repoId: 'repo-1',
        path: '/tmp'
      }
    })
    expect(projectAutomationSelector(byHostId, context()).kind).toBe('orphan')
  })
})

describe('automationSelectorMatchesScope', () => {
  it('requires the SSH generation to match, not just the target id', () => {
    const selector = { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } as const
    expect(
      automationSelectorMatchesScope(selector, {
        kind: 'ssh',
        targetId: 'ssh-1',
        expectedTargetGeneration: 7
      })
    ).toBe(true)
    expect(
      automationSelectorMatchesScope(selector, {
        kind: 'ssh',
        targetId: 'ssh-1',
        expectedTargetGeneration: 6
      })
    ).toBe(false)
  })
})

// Folder workspace pins decide actual dispatch hosts; repo-only projection mislabeled SSH runs as Self.
describe('workspace host pin', () => {
  it('orphans a pin whose SSH target is no longer registered', () => {
    const selector = projectAutomationSelector(
      automation({ workspaceId: 'folder:fw-1' }),
      context({ workspaceHost: () => ({ kind: 'ssh', targetId: 'ssh-gone' }) })
    )

    expect(selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetMissing
    })
  })

  it('orphans a workspace that resolves to more than one host instead of assuming Self', () => {
    const selector = projectAutomationSelector(
      automation({ workspaceId: 'folder:fw-1' }),
      context({ workspaceHost: () => ({ kind: 'ambiguous' }) })
    )

    expect(selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous
    })
  })
})

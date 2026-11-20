import { describe, expect, it } from 'vitest'
import type { Automation } from '../automation-definition'
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
  }
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
  it('qualifies a local record whose project resolves without a connection as self', () => {
    expect(projectAutomationSelector(automation(), context())).toEqual({ kind: 'self' })
  })

  it('refuses to read a bare local value as self when the project is gone', () => {
    expect(projectAutomationSelector(automation({ projectId: 'missing' }), context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.projectMissing
    })
  })

  it('keeps a bot automation, which has no project, as self', () => {
    const bot = automation({
      projectId: '',
      workspaceMode: 'existing',
      workspaceId: 'folder:w1',
      bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
    })
    expect(projectAutomationSelector(bot, context())).toEqual({ kind: 'self' })
    // An older host reads the same record without the bot and refuses it as projectless.
    expect(projectAutomationSelector({ ...bot, bot: undefined }, context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.projectMissing
    })
  })

  it('treats a local record whose project points at an SSH connection as malformed', () => {
    expect(projectAutomationSelector(automation({ projectId: 'repo-ssh' }), context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.malformed
    })
  })

  it('pins an SSH record to its registration generation', () => {
    const record = automation({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1',
      executionTargetGeneration: 7,
      projectId: 'repo-ssh'
    })
    expect(projectAutomationSelector(record, context())).toEqual({
      kind: 'ssh',
      targetId: 'ssh-1',
      targetGeneration: 7
    })
  })

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

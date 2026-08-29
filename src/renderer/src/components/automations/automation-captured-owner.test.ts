import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import type { AutomationHostRow } from './automation-host-cache-types'
import {
  automationActionAvailability,
  captureAutomationOwners,
  capturedAutomationOwner,
  isAutomationActionEnabled,
  UNCAPTURED_AUTOMATION_OWNER
} from './automation-captured-owner'

const DESKTOP_SELF: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}

const RUNTIME_SELF: AutomationOwnerRef = {
  authority: { kind: 'runtime', environmentId: 'gpu', pairingRevision: 1 },
  selector: { kind: 'self' }
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a-1',
    name: 'Nightly',
    prompt: 'sweep',
    precheck: null,
    agentId: 'claude',
    runContext: null,
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
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function row(overrides: Partial<AutomationHostRow>): AutomationHostRow {
  return {
    automation: automation(),
    owner: DESKTOP_SELF,
    selector: { kind: 'self' },
    usageSummary: null,
    usageKnown: false,
    ...overrides
  }
}

describe('captured owner availability', () => {
  it('lets every action through on an owned row and repeats its precondition', () => {
    const availability = automationActionAvailability(
      { owner: DESKTOP_SELF, selector: { kind: 'self' } },
      'run'
    )
    expect(availability).toEqual({
      kind: 'owned',
      owner: DESKTOP_SELF,
      precondition: { selector: { kind: 'self' } }
    })
  })

  it('keeps delete and pause fenceable on an orphan while refusing to run it', () => {
    const orphan = { owner: null, selector: { kind: 'orphan' as const, issue: 'gone' } }
    expect(automationActionAvailability(orphan, 'delete')).toEqual({
      kind: 'orphan-fenced',
      precondition: { selector: { kind: 'orphan' } }
    })
    expect(automationActionAvailability(orphan, 'toggle').kind).toBe('orphan-fenced')
    expect(automationActionAvailability(orphan, 'run').kind).toBe('blocked')
    expect(automationActionAvailability(orphan, 'edit').kind).toBe('blocked')
    expect(isAutomationActionEnabled(orphan, 'run')).toBe(false)
    expect(isAutomationActionEnabled(orphan, 'delete')).toBe(true)
  })

  it('blocks every action on a legacy row and asks for a server update', () => {
    // A qualified selector with no owner means the authority never sent a generation.
    const legacy = { owner: null, selector: { kind: 'ssh' as const, targetId: 'box' } }
    const availability = automationActionAvailability(legacy, 'delete')
    expect(availability.kind).toBe('blocked')
    expect(availability.kind === 'blocked' && availability.block.recovery).toBe('update-server')
  })

  it('reports a row with no metadata as uncaptured rather than blocked', () => {
    expect(automationActionAvailability(UNCAPTURED_AUTOMATION_OWNER, 'run').kind).toBe('uncaptured')
    expect(capturedAutomationOwner(new Map(), 'missing')).toBe(UNCAPTURED_AUTOMATION_OWNER)
    expect(capturedAutomationOwner(null, 'missing')).toBe(UNCAPTURED_AUTOMATION_OWNER)
  })

  it('keys captured owners by row key', () => {
    const captured = captureAutomationOwners([
      { rowKey: 'row|desktop|a-1', row: row({ automation: automation({ id: 'a-1' }) }) },
      {
        rowKey: 'row|desktop|a-2',
        row: row({
          automation: automation({ id: 'a-2' }),
          owner: null,
          selector: { kind: 'orphan', issue: 'gone' }
        })
      }
    ])
    expect(captured.get('row|desktop|a-1')?.owner).toEqual(DESKTOP_SELF)
    expect(captured.get('row|desktop|a-2')?.owner).toBeNull()
  })

  it("keeps both authorities' owners when they hold the same automation ID", () => {
    const captured = captureAutomationOwners([
      { rowKey: 'row|desktop|a-1', row: row({ automation: automation({ id: 'a-1' }) }) },
      {
        rowKey: 'row|runtime|a-1',
        row: row({ automation: automation({ id: 'a-1' }), owner: RUNTIME_SELF })
      }
    ])
    expect(captured.get('row|desktop|a-1')?.owner).toEqual(DESKTOP_SELF)
    expect(captured.get('row|runtime|a-1')?.owner).toEqual(RUNTIME_SELF)
  })
})

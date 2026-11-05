import { describe, expect, it } from 'vitest'
import type { Automation } from './automations-types'
import { AUTOMATION_ORPHAN_ISSUES } from './automation-list-scope'
import { partitionLegacyAutomationList } from './automation-legacy-list-partition'

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-local',
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

const context = {
  repoConnectionId: (repoId: string) =>
    repoId === 'repo-local' ? null : repoId === 'repo-ssh' ? 'ssh-1' : undefined,
  projectsAuthoritative: true
}

/** What a client holds about a foreign authority: a mirror that may simply not be loaded. */
const mirroredContext = { ...context, projectsAuthoritative: false }

describe('partitionLegacyAutomationList', () => {
  it('sends a local record with a resolvable local project to self', () => {
    const [row] = partitionLegacyAutomationList([automation()], context).rows
    expect(row?.selector).toEqual({ kind: 'self' })
  })

  it('sends a valid SSH record to its target with no generation attached', () => {
    const [row] = partitionLegacyAutomationList(
      [automation({ executionTargetType: 'ssh', executionTargetId: 'ssh-1' })],
      context
    ).rows
    expect(row?.selector).toEqual({ kind: 'ssh', targetId: 'ssh-1' })
  })

  it('orphans unknown types, missing SSH ids, and unresolvable projects', () => {
    const partition = partitionLegacyAutomationList(
      [
        automation({ id: 'x', executionTargetType: 'wat' as Automation['executionTargetType'] }),
        automation({ id: 'y', executionTargetType: 'ssh', executionTargetId: '  ' }),
        automation({ id: 'z', projectId: 'repo-gone' })
      ],
      context
    )
    expect(partition.rows.map((row) => row.selector.kind)).toEqual(['orphan', 'orphan', 'orphan'])
    expect(partition.rows[2]?.selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.projectMissing
    })
    expect(partition.orphanCount).toBe(3)
  })

  it('orphans a record scheduled against a runtime instead of moving it', () => {
    const partition = partitionLegacyAutomationList(
      [automation({ schedulerOwner: 'remote_host_service' })],
      context
    )
    expect(partition.rows[0]?.selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.scheduledElsewhere
    })
  })

  it('reports an unresolved project as unverified when the table is only a mirror', () => {
    const partition = partitionLegacyAutomationList(
      [automation({ projectId: 'repo-gone' })],
      mirroredContext
    )
    expect(partition.rows[0]?.selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.projectUnverified
    })
  })

  it('still requires positive evidence for self against a mirrored table', () => {
    const [row] = partitionLegacyAutomationList([automation()], mirroredContext).rows
    expect(row?.selector).toEqual({ kind: 'self' })
  })

  it('does not read a bare local value as self when the project is hosted over SSH', () => {
    const partition = partitionLegacyAutomationList(
      [automation({ projectId: 'repo-ssh' })],
      context
    )
    expect(partition.rows[0]?.selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.malformed
    })
  })
})

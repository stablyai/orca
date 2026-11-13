import { describe, expect, it } from 'vitest'
import { getWorkspaceCleanupAutomationRunReasons } from './workspace-cleanup'
import type { AutomationWorkspaceProvenance } from '../worktree/types'
import type { AutomationRun } from '../automations/history/automation-run'

const PROVENANCE: AutomationWorkspaceProvenance = {
  kind: 'created-by-automation',
  automationId: 'auto-1',
  automationNameSnapshot: 'Nightly patrol',
  automationRunId: 'run-1',
  automationRunTitleSnapshot: 'Nightly patrol #4',
  createdAt: 1,
  executionTargetType: 'local',
  executionTargetId: 'local',
  projectId: 'project-1'
}

function lookup(run: Pick<AutomationRun, 'status' | 'terminalPtyId'> | undefined) {
  return (runId: string) => (runId === 'run-1' ? run : undefined)
}

describe('getWorkspaceCleanupAutomationRunReasons', () => {
  it('marks a workspace whose run finished and released its terminal', () => {
    expect(
      getWorkspaceCleanupAutomationRunReasons(
        PROVENANCE,
        lookup({ status: 'completed', terminalPtyId: null })
      )
    ).toEqual(['automation-run'])
    expect(
      getWorkspaceCleanupAutomationRunReasons(
        PROVENANCE,
        lookup({ status: 'dispatch_failed', terminalPtyId: null })
      )
    ).toEqual(['automation-run'])
  })

  it('keeps a workspace whose run is still going or still holds its terminal', () => {
    expect(
      getWorkspaceCleanupAutomationRunReasons(
        PROVENANCE,
        lookup({ status: 'dispatched', terminalPtyId: null })
      )
    ).toEqual([])
    expect(
      getWorkspaceCleanupAutomationRunReasons(
        PROVENANCE,
        lookup({ status: 'completed', terminalPtyId: 'pty-7' })
      )
    ).toEqual([])
  })

  it('keeps a workspace when this host cannot see the run', () => {
    const finished = lookup({ status: 'completed', terminalPtyId: null })
    expect(
      getWorkspaceCleanupAutomationRunReasons({ ...PROVENANCE, origin: 'client' }, finished)
    ).toEqual([])
    expect(
      getWorkspaceCleanupAutomationRunReasons(
        { ...PROVENANCE, automationRunId: 'run-evicted' },
        finished
      )
    ).toEqual([])
    expect(getWorkspaceCleanupAutomationRunReasons(undefined, finished)).toEqual([])
  })
})

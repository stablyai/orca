import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunViewState } from './automation-run-view-state'

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'manual',
    workspaceId: 'wt-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    outputSnapshot: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

describe('automation run view state', () => {
  it('opens the exact terminal when the run tab is still available', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun(),
        workspaceExists: true,
        terminalTabExists: true
      })
    ).toMatchObject({
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run is open',
      canOpen: true
    })
  })

  it('falls back to opening the workspace when terminal history is gone', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun(),
        workspaceExists: true,
        terminalTabExists: false
      })
    ).toMatchObject({
      availability: 'workspace',
      actionLabel: 'Open workspace',
      statusLabel: 'Opened workspace; original terminal is closed.',
      canOpen: true
    })
  })

  it('keeps skipped or missing-workspace runs as metadata-only history', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun({ workspaceId: null, terminalSessionId: null }),
        workspaceExists: false,
        terminalTabExists: false
      })
    ).toMatchObject({
      availability: 'metadata',
      statusLabel: 'No workspace launched',
      canOpen: false
    })
  })

  it('describes deleted workspaces without the ambiguous unavailable label', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun({ workspaceDisplayName: 'Nightly Checks' }),
        workspaceExists: false,
        terminalTabExists: false
      })
    ).toMatchObject({
      availability: 'metadata',
      statusLabel: 'Nightly Checks no longer available',
      canOpen: false
    })
  })

  it('keeps a deleted-workspace run viewable through its saved snapshot', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun({
          outputSnapshot: {
            format: 'plain_text',
            content: 'Run completed',
            capturedAt: 1,
            truncated: false
          }
        }),
        workspaceExists: false,
        terminalTabExists: false
      })
    ).toMatchObject({
      availability: 'snapshot',
      actionLabel: 'Snapshot saved',
      statusLabel: 'Showing saved run snapshot.',
      canOpen: false
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'

import { resolveAutomationRunOpenTarget } from './automation-run-open-target'

const leafId = '11111111-1111-4111-8111-111111111111'
const otherLeafId = '22222222-2222-4222-8222-222222222222'
const paneKey = `tab-1:${leafId}`

const runLeafLayout = {
  root: { type: 'leaf' as const, leafId },
  activeLeafId: leafId,
  expandedLeafId: null
}
const livePtyIds = ['pty-run']

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'manual',
    workspaceId: 'wt-1',
    workspaceDisplayName: 'Workspace',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: paneKey,
    terminalPtyId: 'pty-run',
    completionAttribution: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

describe('automation run open target', () => {
  it('rejects a layout whose run leaf is bound to another PTY', () => {
    expect(
      resolveAutomationRunOpenTarget({
        run: run(),
        terminalTabExists: true,
        currentLayout: {
          ...runLeafLayout,
          ptyIdsByLeafId: { [leafId]: 'pty-other' }
        },
        livePtyIds
      })
    ).toBeNull()
  })

  it('does not rebuild a layout that is missing the run pane', () => {
    expect(
      resolveAutomationRunOpenTarget({
        run: run(),
        terminalTabExists: true,
        currentLayout: {
          root: { type: 'leaf', leafId: otherLeafId },
          activeLeafId: otherLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [otherLeafId]: 'pty-empty-shell' }
        },
        livePtyIds
      })
    ).toBeNull()
  })

  it('does not open when the current tab layout is unavailable', () => {
    expect(
      resolveAutomationRunOpenTarget({
        run: run(),
        terminalTabExists: true,
        currentLayout: null,
        livePtyIds
      })
    ).toBeNull()
  })
})

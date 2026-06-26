import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  automationRunMatchesPaneKey,
  buildAutomationRunOpenLayout,
  canOpenAutomationRunOpenTarget,
  resolveAutomationRunOpenTarget
} from './automation-run-open-target'

const leafId = '11111111-1111-4111-8111-111111111111'
const otherLeafId = '22222222-2222-4222-8222-222222222222'
const paneKey = `tab-1:${leafId}`
const splitPaneKey = `tab-1:${otherLeafId}`
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
  it('matches exact pane identity only', () => {
    expect(automationRunMatchesPaneKey(run(), paneKey)).toBe(true)
    expect(automationRunMatchesPaneKey(run(), splitPaneKey)).toBe(false)
    expect(
      automationRunMatchesPaneKey(run({ terminalPaneKey: null, terminalPtyId: null }), splitPaneKey)
    ).toBe(false)
  })

  it('requires exact pane identity before treating a run terminal as openable', () => {
    expect(
      canOpenAutomationRunOpenTarget({
        run: run({ terminalPaneKey: null, terminalPtyId: null }),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(false)
    expect(
      canOpenAutomationRunOpenTarget({
        run: run({ terminalPaneKey: `other-tab:${leafId}` }),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(true)
    expect(
      canOpenAutomationRunOpenTarget({
        run: run(),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(true)
  })

  it('requires the run PTY to be live for View run', () => {
    expect(
      canOpenAutomationRunOpenTarget({
        run: run(),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(true)
    expect(
      canOpenAutomationRunOpenTarget({
        run: run(),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds: []
      })
    ).toBe(false)
  })

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

  it('rejects a run without an exact PTY identity', () => {
    expect(
      canOpenAutomationRunOpenTarget({
        run: run({ terminalPtyId: null }),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(false)
  })

  it('opens an existing run leaf when the layout has no PTY mapping yet', () => {
    const target = resolveAutomationRunOpenTarget({
      run: run(),
      terminalTabExists: true,
      currentLayout: runLeafLayout,
      livePtyIds
    })

    expect(target).not.toBeNull()
    if (!target) {
      throw new Error('Expected target.')
    }
    expect(buildAutomationRunOpenLayout({ target, currentLayout: runLeafLayout })).toMatchObject({
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      ptyIdsByLeafId: { [leafId]: 'pty-run' }
    })
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

  it('keeps an existing split layout when the run leaf is still present', () => {
    const currentLayout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId },
        second: { type: 'leaf' as const, leafId: otherLeafId }
      },
      activeLeafId: otherLeafId,
      expandedLeafId: otherLeafId,
      ptyIdsByLeafId: { [leafId]: 'pty-run', [otherLeafId]: 'pty-other' }
    }
    const target = resolveAutomationRunOpenTarget({
      run: run(),
      terminalTabExists: true,
      currentLayout,
      livePtyIds
    })

    expect(target).not.toBeNull()
    if (!target) {
      throw new Error('Expected target.')
    }
    const layout = buildAutomationRunOpenLayout({
      target,
      currentLayout
    })

    expect(layout).toMatchObject({
      root: expect.objectContaining({ type: 'split' }),
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: 'pty-run', [otherLeafId]: 'pty-other' }
    })
  })
})

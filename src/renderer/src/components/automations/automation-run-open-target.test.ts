import { describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  automationRunMatchesPaneKey,
  buildAutomationRunOpenLayout,
  resolveAutomationRunOpenTarget,
  resolveAutomationRunTerminalTarget
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
const canOpen = (args: Parameters<typeof resolveAutomationRunOpenTarget>[0]): boolean =>
  resolveAutomationRunOpenTarget(args) !== null

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
      canOpen({
        run: run({ terminalPaneKey: null, terminalPtyId: null }),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(false)
    expect(
      canOpen({
        run: run({ terminalPaneKey: `other-tab:${leafId}` }),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(true)
    expect(
      canOpen({
        run: run(),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(true)
  })

  it('requires the run PTY to be live for View run', () => {
    expect(
      canOpen({
        run: run(),
        terminalTabExists: true,
        currentLayout: runLeafLayout,
        livePtyIds
      })
    ).toBe(true)
    expect(
      canOpen({
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

  it('targets the pane a successful run slept in place, before and after it wakes', () => {
    // Why: hibernation drops only the run's PTY id; the pane key still names the run's own pane.
    const sleptRun = run({ terminalPtyId: null })
    const asleepLayout = { ...runLeafLayout, ptyIdsByLeafId: { [leafId]: 'pty-run' } }
    const asleep = resolveAutomationRunOpenTarget({
      run: sleptRun,
      terminalTabExists: true,
      currentLayout: asleepLayout,
      livePtyIds: []
    })

    expect(asleep).toEqual({ tabId: 'tab-1', paneKey, leafId, ptyId: null })
    if (!asleep) {
      throw new Error('Expected target.')
    }
    expect(
      buildAutomationRunOpenLayout({ target: asleep, currentLayout: asleepLayout }).ptyIdsByLeafId
    ).toBe(asleepLayout.ptyIdsByLeafId)
    expect(
      resolveAutomationRunOpenTarget({
        run: sleptRun,
        terminalTabExists: true,
        currentLayout: { ...runLeafLayout, ptyIdsByLeafId: { [leafId]: 'pty-resumed' } },
        livePtyIds: ['pty-resumed']
      })
    ).toEqual({ tabId: 'tab-1', paneKey, leafId, ptyId: 'pty-resumed' })
    expect(
      canOpen({
        run: sleptRun,
        terminalTabExists: false,
        currentLayout: asleepLayout,
        livePtyIds: []
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

describe('paired run pane ownership', () => {
  const mirroredTabId = toWebTerminalSurfaceTabId('tab-1')
  const binding = toRemoteRuntimePtyId('handle-1', 'env-a')

  it.each([
    { name: 'sleeping', ptyId: binding, live: [], present: true, expected: null },
    { name: 'awake', ptyId: binding, live: [binding], present: true, expected: binding },
    { name: 'dead running', runPtyId: 'pty-run', ptyId: binding, live: [], present: true },
    {
      name: 'wrong host',
      ptyId: toRemoteRuntimePtyId('handle-1', 'env-b'),
      live: [],
      present: true
    },
    { name: 'local binding', ptyId: 'local-pty', live: [], present: true },
    { name: 'missing leaf', ptyId: binding, live: [], present: false },
    { name: 'missing binding', ptyId: undefined, live: [], present: true }
  ])('validates a $name mirror', ({ runPtyId, ptyId, live, present, expected }) => {
    const target = resolveAutomationRunTerminalTarget(
      run({ terminalPtyId: runPtyId ?? null }),
      {
        hasTerminalTab: (tabId) => tabId === mirroredTabId,
        terminalLayoutsByTabId: {
          [mirroredTabId]: {
            ...runLeafLayout,
            root: { type: 'leaf', leafId: present ? leafId : otherLeafId },
            ptyIdsByLeafId: ptyId ? { [leafId]: ptyId } : {}
          }
        },
        ptyIdsByTabId: { [mirroredTabId]: live }
      },
      'env-a'
    )
    expect(target).toEqual(
      expected === undefined
        ? null
        : {
            tabId: mirroredTabId,
            paneKey: `${mirroredTabId}:${leafId}`,
            leafId,
            ptyId: expected
          }
    )
  })

  it('opens a run that already names its mirrored pane', () => {
    const mirroredPaneKey = `${mirroredTabId}:${leafId}`
    expect(
      resolveAutomationRunTerminalTarget(
        run({ terminalPaneKey: mirroredPaneKey, terminalPtyId: binding }),
        {
          hasTerminalTab: (tabId) => tabId === mirroredTabId,
          terminalLayoutsByTabId: {
            [mirroredTabId]: { ...runLeafLayout, ptyIdsByLeafId: { [leafId]: binding } }
          },
          ptyIdsByTabId: { [mirroredTabId]: [binding] }
        },
        'env-a'
      )
    ).toEqual({ tabId: mirroredTabId, paneKey: mirroredPaneKey, leafId, ptyId: binding })
  })

  it('keeps the local tab of a run this client launched in a paired workspace', () => {
    // Why: this client's own launch on the server keeps its own tab id, not a mirrored one.
    expect(
      resolveAutomationRunTerminalTarget(
        run({ terminalPtyId: null }),
        {
          hasTerminalTab: (tabId) => tabId === 'tab-1',
          terminalLayoutsByTabId: {
            'tab-1': { ...runLeafLayout, ptyIdsByLeafId: { [leafId]: binding } }
          },
          ptyIdsByTabId: {}
        },
        'env-a'
      )
    ).toEqual({ tabId: 'tab-1', paneKey, leafId, ptyId: null })
  })
})

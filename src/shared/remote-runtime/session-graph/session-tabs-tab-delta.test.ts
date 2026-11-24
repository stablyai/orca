import { describe, expect, it } from 'vitest'
import { SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY } from '../protocol/session-tabs-runtime-capabilities'
import {
  createSessionTabsTabDeltaDecoder,
  createSessionTabsTabDeltaEncoder
} from './session-tabs-tab-delta'

const CAPABLE = [SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY]

function terminalTab(index: number, status = 'done'): Record<string, unknown> {
  return {
    type: 'terminal',
    id: `tab-${index}::leaf-${index}`,
    title: `Claude Code ${index}`,
    parentTabId: `tab-${index}`,
    leafId: `leaf-${index}`,
    ptyId: `pty-${index}`,
    isActive: index === 0,
    agentStatus: {
      state: status,
      prompt: `Fix the flaky test number ${index} in the integration suite`,
      updatedAt: 1_760_000_000_000 + index,
      stateStartedAt: 1_760_000_000_000,
      paneKey: `tab-${index}:leaf-${index}`,
      agentType: 'claude',
      stateHistory: []
    }
  }
}

function frame(snapshotVersion: number, tabs: Record<string, unknown>[], worktree = 'wt-1') {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'group-1',
    activeTabId: 'tab-0',
    activeTabType: 'terminal' as const,
    tabs
  }
}

function seventeenTabs(): Record<string, unknown>[] {
  return Array.from({ length: 17 }, (_, index) => terminalTab(index))
}

function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('session tabs tab delta', () => {
  it('leaves frames untouched for a client that did not advertise it (old client, new host)', () => {
    const encoder = createSessionTabsTabDeltaEncoder([])
    const initial = frame(1, seventeenTabs())
    const next = frame(
      2,
      seventeenTabs().map((tab, i) => (i === 3 ? terminalTab(3, 'working') : tab))
    )
    expect(encoder.full(initial)).toBe(initial)
    expect(encoder.update(next)).toBe(next)
  })

  it('passes a legacy host stream through unchanged (new client, old host)', () => {
    const decoder = createSessionTabsTabDeltaDecoder()
    const census = wire({ type: 'snapshots', snapshots: [frame(1, seventeenTabs())] })
    const update = wire({ type: 'updated', ...frame(2, seventeenTabs()) })
    expect(decoder.decode(census)).toEqual({ ok: true, result: census })
    expect(decoder.decode(update)).toEqual({ ok: true, result: update })
  })

  it('sends a worktree whole after it was removed or never sent on this stream', () => {
    const encoder = createSessionTabsTabDeltaEncoder(CAPABLE)
    const removed = { ...frame(2, []), removed: true as const }
    expect(encoder.update(frame(1, seventeenTabs()))).toHaveProperty('tabs')
    expect(encoder.update(removed)).toBe(removed)
    expect(encoder.update(frame(3, seventeenTabs()))).toHaveProperty('tabs')
  })

  it('refuses a delta whose base is not the last frame it delivered', () => {
    const encoder = createSessionTabsTabDeltaEncoder(CAPABLE)
    const decoder = createSessionTabsTabDeltaDecoder()
    decoder.decode(wire({ type: 'snapshot', ...encoder.full(frame(1, seventeenTabs())) }))
    const skipped = encoder.update(
      frame(2, [terminalTab(0, 'working'), ...seventeenTabs().slice(1)])
    )
    expect(skipped).toHaveProperty('tabsDelta')
    const next = wire({ type: 'updated', ...encoder.update(frame(3, seventeenTabs())) })
    expect(decoder.decode(next)).toEqual({ ok: false })
    expect(
      createSessionTabsTabDeltaDecoder().decode(wire({ type: 'updated', ...skipped }))
    ).toEqual({ ok: false })
  })

  it('refuses a delta that points past its base', () => {
    const decoder = createSessionTabsTabDeltaDecoder()
    decoder.decode({ type: 'snapshot', ...frame(1, [terminalTab(0)]), tabsRevision: 1 })
    const { tabs: _tabs, ...rest } = frame(2, [])
    expect(
      decoder.decode({
        type: 'updated',
        ...rest,
        tabsRevision: 2,
        tabsDelta: { baseRevision: 1, tabs: [4] }
      })
    ).toEqual({ ok: false })
  })
})

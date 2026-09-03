import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from './terminal-tab-activity-status'

// Why: #9040 — the tab-bar dot shares the sidebar's attribution gate, so Claude's
// token-less spinner title must reach 'working' here too. TerminalTabActivityInput
// narrows `tab` with a Pick; because launchAgent is optional, dropping it from that
// Pick compiles cleanly and would silently revert this path alone.
describe('#9040 terminal tab dot attributes spinner titles to the launched agent', () => {
  beforeEach(() => {
    resetTerminalTabActivityFlagsCacheForTest()
  })

  it('reports working for a Claude spinner pane title on a live tab', () => {
    const status = resolveTerminalTabActivityStatus({
      tab: {
        id: 'tab-1',
        title: 'bash',
        launchAgent: 'claude'
      } satisfies Partial<TerminalTab> as TerminalTab,
      runtimePaneTitlesByTabId: { 'tab-1': { 0: '⠋ implementing the feature' } },
      ptyIdsByTabId: { 'tab-1': ['pty-0'] }
    })

    expect(status).toBe('working')
  })

  // Control: the named-provider path this must stay at parity with.
  it('reports working for a named-provider pane title', () => {
    const status = resolveTerminalTabActivityStatus({
      tab: { id: 'tab-1', title: 'bash' } as TerminalTab,
      runtimePaneTitlesByTabId: { 'tab-1': { 0: 'claude [working]' } },
      ptyIdsByTabId: { 'tab-1': ['pty-0'] }
    })

    expect(status).toBe('working')
  })

  it('stays out of working for a spinner pane title with no launch identity', () => {
    const status = resolveTerminalTabActivityStatus({
      tab: { id: 'tab-1', title: 'bash' } as TerminalTab,
      runtimePaneTitlesByTabId: { 'tab-1': { 0: '⠐ Review branch for regressions' } },
      ptyIdsByTabId: { 'tab-1': ['pty-0'] }
    })

    expect(status).not.toBe('working')
  })

  // Why (STA-2926): the tab-bar dot resolves through the same heuristic as the sidebar, so it
  // inherits the same rule — a title left on the tab after its pane stopped publishing is a
  // stale leftover with no pane to attribute it to, and must not light the dot.
  it('does not report working for an agent title no pane is publishing', () => {
    for (const tab of [
      { id: 'tab-1', title: '⠋ implementing the feature', launchAgent: 'claude' },
      { id: 'tab-1', title: 'claude [working]' }
    ] satisfies Partial<TerminalTab>[]) {
      const status = resolveTerminalTabActivityStatus({
        tab: tab as TerminalTab,
        ptyIdsByTabId: { 'tab-1': ['pty-0'] }
      })

      expect(status).toBe('active')
    }
  })
})

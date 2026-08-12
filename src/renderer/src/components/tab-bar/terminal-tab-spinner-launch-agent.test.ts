import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
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

  it('reports working for a Claude spinner title on a live tab', () => {
    const status = resolveTerminalTabActivityStatus({
      tab: {
        id: 'tab-1',
        title: '⠋ implementing the feature',
        launchAgent: 'claude'
      } satisfies Partial<TerminalTab> as TerminalTab,
      ptyIdsByTabId: { 'tab-1': ['pty-0'] }
    })

    expect(status).toBe('working')
  })

  // Control: the named-provider path this must stay at parity with.
  it('reports working for a named-provider title', () => {
    const status = resolveTerminalTabActivityStatus({
      tab: { id: 'tab-1', title: 'claude [working]' } as TerminalTab,
      ptyIdsByTabId: { 'tab-1': ['pty-0'] }
    })

    expect(status).toBe('working')
  })

  it('stays out of working for a spinner title with no launch identity', () => {
    const status = resolveTerminalTabActivityStatus({
      tab: { id: 'tab-1', title: '⠐ Review branch for regressions' } as TerminalTab,
      ptyIdsByTabId: { 'tab-1': ['pty-0'] }
    })

    expect(status).not.toBe('working')
  })
})

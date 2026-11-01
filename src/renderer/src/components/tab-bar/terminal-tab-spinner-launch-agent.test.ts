import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from './terminal-tab-activity-status'

// Keep optional launchAgent in the resolver’s Pick so providerless spinners retain sidebar attribution.
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

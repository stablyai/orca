import { describe, expect, it } from 'vitest'
import { classifyRemoteServerPaneRetries } from './remote-server-pane-retries'

describe('classifyRemoteServerPaneRetries', () => {
  it('says stopped only when no outage pane is still retrying', () => {
    const latched = { phase: 'disconnected' as const }
    const parked = { phase: 'recovering' as const, waiting: true as const }
    const retrying = { phase: 'backoff' as const }
    expect(classifyRemoteServerPaneRetries([latched, parked])).toBe('latched')
    expect(classifyRemoteServerPaneRetries([latched, retrying, parked])).toBe('retrying')
    // Ownership handoffs, sign-in waits and idle panes never decide the card's state.
    expect(
      classifyRemoteServerPaneRetries([
        undefined,
        { phase: 'recovering', reason: 'ownership' },
        { phase: 'backoff', reason: 'ssh-sign-in' }
      ])
    ).toBeNull()
    expect(
      classifyRemoteServerPaneRetries([{ phase: 'recovering', reason: 'ownership' }, latched])
    ).toBe('latched')
  })
})

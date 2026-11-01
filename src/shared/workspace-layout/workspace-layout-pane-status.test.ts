import { describe, expect, it } from 'vitest'
import { derivePaneStatus, type PaneStatusFacts } from './workspace-layout-pane-status'

const idle: PaneStatusFacts = {
  starting: false,
  lastOutcome: null,
  sleeping: false,
  terminal: null,
  host: 'reachable'
}

describe('derivePaneStatus', () => {
  it.each([
    [{}, 'restorable'],
    [{ terminal: 'live' }, 'running'],
    [{ terminal: 'exited' }, 'exited'],
    [{ terminal: 'unverifiable' }, 'unverifiable'],
    [{ sleeping: true }, 'sleeping'],
    [{ lastOutcome: 'failed' }, 'failed'],
    [{ lastOutcome: 'exited', terminal: 'exited' }, 'exited'],
    [{ host: 'awaiting', terminal: 'live' }, 'waiting_for_host'],
    [{ host: 'awaiting' }, 'waiting_for_host'],
    [{ host: 'lost', terminal: 'live' }, 'unverifiable'],
    [{ host: 'lost' }, 'waiting_for_host'],
    [{ host: 'lost', terminal: 'exited' }, 'exited']
  ] as const)('%o derives %s', (facts, status) => {
    expect(derivePaneStatus({ ...idle, ...facts })).toBe(status)
  })

  it('shows a start in flight over everything else', () => {
    expect(
      derivePaneStatus({
        starting: true,
        lastOutcome: 'failed',
        sleeping: true,
        terminal: 'exited',
        host: 'lost'
      })
    ).toBe('starting')
  })

  it("keeps a pane's own outcome and sleeping record when its host cannot be reached", () => {
    expect(derivePaneStatus({ ...idle, lastOutcome: 'failed', host: 'lost' })).toBe('failed')
    expect(derivePaneStatus({ ...idle, sleeping: true, host: 'awaiting' })).toBe('sleeping')
  })

  it('shows a kept exit, not a restart, until the pane is started again', () => {
    expect(derivePaneStatus({ ...idle, lastOutcome: 'exited' })).toBe('exited')
  })
})

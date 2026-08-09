import { describe, expect, it } from 'vitest'
import {
  acknowledgeTerminalParkEpisodeLease,
  reconcileTerminalParkEpisodeLease,
  terminalParkEpisodeLeaseUnmountsPane,
  type TerminalParkEpisodeLease
} from './terminal-park-episode-lease'
import type {
  TerminalParkedWatcherCoveragePlan,
  TerminalParkedWatcherCoveredPlan
} from './terminal-parked-watcher-coverage-plan'

const coveredPlan = (materialKey: string): TerminalParkedWatcherCoveredPlan => ({
  status: 'covered',
  materialKey,
  worktreeId: 'worktree-1',
  tabId: 'tab-1',
  tabPtyId: 'pty-1',
  generation: 1,
  panes: [{ leafId: '11111111-1111-4111-8111-111111111111', ptyId: 'pty-1' }]
})

describe('terminal park episode lease', () => {
  it('requests covered plans and becomes covering only after an exact acknowledgement', () => {
    const requested = reconcileTerminalParkEpisodeLease(null, coveredPlan('key-1'))
    const covering = acknowledgeTerminalParkEpisodeLease(requested, {
      status: 'covering',
      tabId: 'tab-1',
      materialKey: 'key-1',
      watchedPtyIds: ['pty-1']
    })

    expect(requested.phase).toBe('requested')
    expect(covering.phase).toBe('covering')
    expect(terminalParkEpisodeLeaseUnmountsPane(covering)).toBe(true)
  })

  it('keeps covering acknowledgements identity-stable across repeated effects', () => {
    const covering: TerminalParkEpisodeLease = {
      phase: 'covering',
      plan: coveredPlan('key-1')
    }

    expect(
      acknowledgeTerminalParkEpisodeLease(covering, {
        status: 'covering',
        tabId: 'tab-1',
        materialKey: 'key-1',
        watchedPtyIds: ['pty-1']
      })
    ).toBe(covering)
  })

  it('latches rejection until the semantic key changes', () => {
    const requested = reconcileTerminalParkEpisodeLease(null, coveredPlan('key-1'))
    const rejected = acknowledgeTerminalParkEpisodeLease(requested, {
      status: 'failed',
      tabId: 'tab-1',
      materialKey: 'key-1',
      reason: 'watcher-coverage-incomplete',
      expectedPtyIds: ['pty-1'],
      watchedPtyIds: []
    })

    expect(reconcileTerminalParkEpisodeLease(rejected, coveredPlan('key-1'))).toBe(rejected)
    expect(reconcileTerminalParkEpisodeLease(rejected, coveredPlan('key-2')).phase).toBe(
      'requested'
    )
    expect(terminalParkEpisodeLeaseUnmountsPane(rejected)).toBe(false)
  })

  it('keeps pending and blocked plans mounted without a timer', () => {
    const pending: TerminalParkedWatcherCoveragePlan = {
      ...coveredPlan('pending-key'),
      status: 'pending',
      issue: { reason: 'provider-capability-pending' }
    }
    const blocked: TerminalParkedWatcherCoveragePlan = {
      ...coveredPlan('blocked-key'),
      status: 'blocked',
      issue: { reason: 'provider-snapshot-unavailable' }
    }

    expect(
      terminalParkEpisodeLeaseUnmountsPane(reconcileTerminalParkEpisodeLease(null, pending))
    ).toBe(false)
    expect(
      terminalParkEpisodeLeaseUnmountsPane(reconcileTerminalParkEpisodeLease(null, blocked))
    ).toBe(false)
  })

  it('makes retention force-parking an explicit uncovered bypass', () => {
    const blocked: TerminalParkedWatcherCoveragePlan = {
      ...coveredPlan('blocked-key'),
      status: 'blocked',
      issue: { reason: 'provider-snapshot-unavailable' }
    }
    const forced = reconcileTerminalParkEpisodeLease(null, blocked, { forceUnmount: true })

    expect(forced.phase).toBe('forced')
    expect(terminalParkEpisodeLeaseUnmountsPane(forced)).toBe(true)
    expect(reconcileTerminalParkEpisodeLease(forced, blocked, { forceUnmount: true })).toBe(forced)
    expect(reconcileTerminalParkEpisodeLease(forced, blocked).phase).toBe('blocked')
  })
})

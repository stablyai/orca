import { describe, expect, it } from 'vitest'
import {
  computePaneMountPolicy,
  nextDwellExpiryAt,
  shouldMountTerminalPaneNow,
  type PaneMountCandidate,
  type PaneMountPolicyInput
} from './pane-mount-policy'

const NOW = 1_000_000

function candidate(overrides: Partial<PaneMountCandidate> & { tabId: string }): PaneMountCandidate {
  return {
    worktreeId: 'wt-1',
    isVisible: false,
    lastVisibleAt: NOW,
    ptyState: 'live',
    hasWakeHint: false,
    isParked: false,
    ...overrides
  }
}

function policy(
  candidates: PaneMountCandidate[],
  overrides: Partial<PaneMountPolicyInput> = {}
): PaneMountPolicyInput {
  return {
    candidates,
    nowMs: NOW,
    evictionEnabled: true,
    warmBudget: 12,
    evictAfterMs: 5 * 60_000,
    ...overrides
  }
}

describe('shouldMountTerminalPaneNow (flag-OFF inertness)', () => {
  const base = {
    evictionEnabled: true,
    isVisible: false,
    hasActivityPortal: false,
    isWarm: false,
    isParked: false
  }

  it('disabled → mount-everything branch: a hidden, non-warm, non-parked tab still mounts', () => {
    // Byte-identical to the pre-eviction app, where every hidden tab stayed
    // mounted regardless of the coordinator (which does not run when disabled).
    expect(shouldMountTerminalPaneNow({ ...base, evictionEnabled: false })).toBe(true)
  })

  it('disabled → a parked pane stays unmounted (claimable on demand, no batch remount)', () => {
    // A runtime flag-OFF must not force-remount the whole parked set; parked
    // panes remount lazily on next visit (disable reconciliation).
    expect(shouldMountTerminalPaneNow({ ...base, evictionEnabled: false, isParked: true })).toBe(
      false
    )
  })

  it('disabled → a visible parked pane still mounts (visibility wins)', () => {
    expect(
      shouldMountTerminalPaneNow({
        ...base,
        evictionEnabled: false,
        isParked: true,
        isVisible: true
      })
    ).toBe(true)
  })

  it('enabled → mounts only visible/portal/warm; evicted and never-visited hidden tabs do not', () => {
    expect(shouldMountTerminalPaneNow({ ...base, isVisible: true })).toBe(true)
    expect(shouldMountTerminalPaneNow({ ...base, hasActivityPortal: true })).toBe(true)
    expect(shouldMountTerminalPaneNow({ ...base, isWarm: true })).toBe(true)
    // Hidden, not warm (evicted or never-visited) → no pane (the mount-storm fix).
    expect(shouldMountTerminalPaneNow({ ...base })).toBe(false)
  })
})

describe('computePaneMountPolicy', () => {
  it('never evicts a visible pane regardless of budget/dwell', () => {
    const result = computePaneMountPolicy(
      policy([candidate({ tabId: 'a', isVisible: true, lastVisibleAt: NOW - 60 * 60_000 })], {
        warmBudget: 0
      })
    )
    expect(result.classifications.get('a')).toBe('visible')
    expect(result.mountedTabIds.has('a')).toBe(true)
  })

  it('treats an Activity-portaled tab as visible input (Tier 0, exempt from eviction)', () => {
    // The coordinator resolves portal membership into isVisible; a portaled tab
    // that is otherwise inactive and long-hidden must still classify as visible.
    const result = computePaneMountPolicy(
      policy([candidate({ tabId: 'portal', isVisible: true, lastVisibleAt: NOW - 30 * 60_000 })], {
        warmBudget: 0,
        evictAfterMs: 1
      })
    )
    expect(result.classifications.get('portal')).toBe('visible')
    expect(result.evictTabIds.size).toBe(0)
  })

  it('parked panes do not consume warm-budget rank slots', () => {
    // A parked pane is always classified 'evict' regardless of rank, so letting
    // it into the ranking pool would silently steal a warm slot from a live
    // hidden pane, evicting it earlier than warmBudget intends.
    const result = computePaneMountPolicy(
      policy(
        [
          candidate({ tabId: 'parked', isParked: true, lastVisibleAt: NOW - 1_000 }),
          candidate({ tabId: 'a', lastVisibleAt: NOW - 2_000 }),
          candidate({ tabId: 'b', lastVisibleAt: NOW - 3_000 }),
          candidate({ tabId: 'c', lastVisibleAt: NOW - 4_000 })
        ],
        { warmBudget: 3 }
      )
    )
    expect(result.classifications.get('parked')).toBe('evict')
    // All three live hidden panes keep their warm slots.
    expect(result.classifications.get('a')).toBe('warm')
    expect(result.classifications.get('b')).toBe('warm')
    expect(result.classifications.get('c')).toBe('warm')
  })

  it('exempts newborn (unbound), dead, and wake-hint panes', () => {
    const result = computePaneMountPolicy(
      policy(
        [
          candidate({ tabId: 'newborn', ptyState: 'newborn', lastVisibleAt: null }),
          candidate({ tabId: 'dead', ptyState: 'dead', lastVisibleAt: NOW - 60 * 60_000 }),
          candidate({ tabId: 'wake', hasWakeHint: true, lastVisibleAt: NOW - 60 * 60_000 })
        ],
        { warmBudget: 0 }
      )
    )
    expect(result.classifications.get('newborn')).toBe('exempt')
    expect(result.classifications.get('dead')).toBe('exempt')
    expect(result.classifications.get('wake')).toBe('exempt')
    expect(result.evictTabIds.size).toBe(0)
  })

  it('keeps the warmBudget most-recently-visible hidden panes and evicts the rest (LRU)', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate({ tabId: `t${i}`, lastVisibleAt: NOW - i * 1000 })
    )
    const result = computePaneMountPolicy(policy(candidates, { warmBudget: 3 }))
    // t0..t2 most recent -> warm; t3,t4 -> evict.
    expect(result.classifications.get('t0')).toBe('warm')
    expect(result.classifications.get('t2')).toBe('warm')
    expect(result.classifications.get('t3')).toBe('evict')
    expect(result.classifications.get('t4')).toBe('evict')
  })

  it('evicts a warm pane once it passes the dwell window even within budget', () => {
    const result = computePaneMountPolicy(
      policy(
        [
          candidate({ tabId: 'fresh', lastVisibleAt: NOW - 1000 }),
          candidate({ tabId: 'stale', lastVisibleAt: NOW - 6 * 60_000 })
        ],
        { warmBudget: 12, evictAfterMs: 5 * 60_000 }
      )
    )
    expect(result.classifications.get('fresh')).toBe('warm')
    expect(result.classifications.get('stale')).toBe('evict')
  })

  it('evicts a live hidden pane that has never been visible (null lastVisibleAt)', () => {
    const result = computePaneMountPolicy(
      policy([candidate({ tabId: 'bg', lastVisibleAt: null })], { warmBudget: 12 })
    )
    expect(result.classifications.get('bg')).toBe('evict')
  })

  it('sinks null-lastVisibleAt panes below timestamped panes in the LRU ranking', () => {
    const result = computePaneMountPolicy(
      policy(
        [
          candidate({ tabId: 'timestamped', lastVisibleAt: NOW - 10 * 60_000 }),
          candidate({ tabId: 'null-a', lastVisibleAt: null }),
          candidate({ tabId: 'null-b', lastVisibleAt: null })
        ],
        { warmBudget: 1, evictAfterMs: 60 * 60_000 }
      )
    )
    // Only 1 warm slot; the timestamped pane ranks above the nulls. It is within
    // dwell so it stays warm; the nulls are out of budget AND out of dwell.
    expect(result.classifications.get('timestamped')).toBe('warm')
    expect(result.classifications.get('null-a')).toBe('evict')
    expect(result.classifications.get('null-b')).toBe('evict')
  })

  describe('disabled (kill switch / self-disable)', () => {
    it('keeps live hidden panes mounted (no new evictions)', () => {
      const result = computePaneMountPolicy(
        policy([candidate({ tabId: 'a', lastVisibleAt: NOW - 60 * 60_000 })], {
          evictionEnabled: false,
          warmBudget: 0,
          evictAfterMs: 1
        })
      )
      expect(result.classifications.get('a')).toBe('warm')
      expect(result.evictTabIds.size).toBe(0)
    })

    it('leaves already-parked panes parked (claimable on visit, no batch remount)', () => {
      const result = computePaneMountPolicy(
        policy([candidate({ tabId: 'parked', isParked: true })], { evictionEnabled: false })
      )
      expect(result.classifications.get('parked')).toBe('evict')
      expect(result.mountedTabIds.has('parked')).toBe(false)
    })
  })

  it('remounts a parked pane only when it becomes visible', () => {
    const parkedHidden = computePaneMountPolicy(
      policy([candidate({ tabId: 'p', isParked: true, isVisible: false })])
    )
    expect(parkedHidden.classifications.get('p')).toBe('evict')

    const parkedVisible = computePaneMountPolicy(
      policy([candidate({ tabId: 'p', isParked: true, isVisible: true })])
    )
    expect(parkedVisible.classifications.get('p')).toBe('visible')
  })
})

describe('nextDwellExpiryAt', () => {
  it('returns the soonest warm-pane dwell boundary', () => {
    const at = nextDwellExpiryAt(
      policy(
        [
          candidate({ tabId: 'a', lastVisibleAt: NOW - 60_000 }),
          candidate({ tabId: 'b', lastVisibleAt: NOW - 120_000 })
        ],
        { evictAfterMs: 5 * 60_000 }
      )
    )
    // b is older, so its dwell boundary (lastVisibleAt + evictAfterMs) is soonest.
    expect(at).toBe(NOW - 120_000 + 5 * 60_000)
  })

  it('returns null when eviction is disabled', () => {
    expect(
      nextDwellExpiryAt(policy([candidate({ tabId: 'a' })], { evictionEnabled: false }))
    ).toBeNull()
  })

  it('returns null when nothing is warm', () => {
    expect(nextDwellExpiryAt(policy([candidate({ tabId: 'a', isVisible: true })]))).toBeNull()
  })
})

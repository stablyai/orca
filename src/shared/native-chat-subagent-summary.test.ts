import { describe, expect, it } from 'vitest'
import {
  isSubagentGroupFallbackText,
  isTerminalSubagentState,
  normalizeSubagentState,
  subagentGroupFallbackText,
  summarizeSubagentGroup
} from './native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from './native-chat-types'

function agent(entry: Partial<NativeChatSubagentEntry>): NativeChatSubagentEntry {
  return { id: 'a', label: 'task', state: 'working', ...entry }
}

describe('summarizeSubagentGroup', () => {
  it('collapses in-flight children into one working count', () => {
    const summary = summarizeSubagentGroup([
      agent({ id: 'a', state: 'working' }),
      agent({ id: 'b', state: 'working' }),
      agent({ id: 'c', state: 'completed' })
    ])

    expect(summary).toMatchObject({ total: 3, working: 2, settledState: null, settledCount: 0 })
  })

  it('ranks the settled verdict worst-first and reports ✓ completed last', () => {
    const cascade: [NativeChatSubagentEntry['state'][], string][] = [
      [['failed', 'stopped', 'idle', 'completed'], 'failed'],
      [['stopped', 'idle', 'completed'], 'stopped'],
      [['unverifiable', 'idle', 'completed'], 'unverifiable'],
      [['idle', 'completed'], 'idle'],
      [['completed', 'completed'], 'completed']
    ]

    for (const [states, expected] of cascade) {
      const summary = summarizeSubagentGroup(
        states.map((state, index) => agent({ id: `a${index}`, state }))
      )
      expect(summary.settledState).toBe(expected)
    }
  })

  it('counts how many children hold the winning verdict', () => {
    const summary = summarizeSubagentGroup([
      agent({ id: 'a', state: 'failed' }),
      agent({ id: 'b', state: 'failed' }),
      agent({ id: 'c', state: 'completed' })
    ])

    expect(summary).toMatchObject({ settledState: 'failed', settledCount: 2 })
  })

  it('sums the per-child token snapshots and leaves them null when none reported', () => {
    expect(
      summarizeSubagentGroup([
        agent({ id: 'a', tokens: 40661 }),
        agent({ id: 'b', tokens: 1000 }),
        agent({ id: 'c' })
      ]).tokens
    ).toBe(41661)
    expect(summarizeSubagentGroup([agent({ id: 'a' })]).tokens).toBeNull()
  })

  it('reports the earliest start and withholds a settled time while work continues', () => {
    const working = summarizeSubagentGroup([
      agent({ id: 'a', state: 'completed', startedAt: 50, settledAt: 80 }),
      agent({ id: 'b', state: 'working', startedAt: 20 })
    ])
    const settled = summarizeSubagentGroup([
      agent({ id: 'a', state: 'completed', startedAt: 50, settledAt: 80 }),
      agent({ id: 'b', state: 'stopped', startedAt: 20, settledAt: 95 })
    ])

    expect(working).toMatchObject({ startedAt: 20, settledAt: null })
    expect(settled).toMatchObject({ startedAt: 20, settledAt: 95 })
  })

  it('reads a state this build does not know as unverifiable, never as working', () => {
    expect(normalizeSubagentState('paused-for-review')).toBe('unverifiable')
    expect(isTerminalSubagentState('paused-for-review')).toBe(true)
    expect(summarizeSubagentGroup([agent({ state: 'unheard-of' as 'working' })])).toMatchObject({
      working: 0,
      settledState: 'unverifiable'
    })
  })

  it('reports an adverse outcome before the group settles', () => {
    const summary = summarizeSubagentGroup([
      agent({ id: 'a', state: 'working' }),
      agent({ id: 'b', state: 'working' }),
      agent({ id: 'c', state: 'failed' })
    ])

    // The group verdict is still withheld, but the failure is not.
    expect(summary).toMatchObject({
      working: 2,
      settledState: null,
      adverseState: 'failed',
      adverseCount: 1
    })
  })

  it('ranks the adverse outcome worst-first and ignores benign settled states', () => {
    expect(
      summarizeSubagentGroup([
        agent({ id: 'a', state: 'working' }),
        agent({ id: 'b', state: 'stopped' }),
        agent({ id: 'c', state: 'failed' })
      ]).adverseState
    ).toBe('failed')
    expect(
      summarizeSubagentGroup([
        agent({ id: 'a', state: 'working' }),
        agent({ id: 'b', state: 'idle' }),
        agent({ id: 'c', state: 'completed' })
      ]).adverseState
    ).toBeNull()
  })

  it('keeps working the only non-terminal state', () => {
    expect(isTerminalSubagentState('working')).toBe(false)
    for (const state of ['idle', 'completed', 'failed', 'stopped', 'unverifiable']) {
      expect(isTerminalSubagentState(state)).toBe(true)
    }
  })
})

describe('subagentGroupFallbackText', () => {
  it('names the failure a client without the block type would otherwise never see', () => {
    expect(
      subagentGroupFallbackText([
        agent({ id: 'a', state: 'working' }),
        agent({ id: 'b', state: 'working' }),
        agent({ id: 'c', state: 'failed' })
      ])
    ).toBe('Kicked off 3 subagents (1 failed)')
    expect(
      subagentGroupFallbackText([
        agent({ id: 'a', state: 'completed' }),
        agent({ id: 'b', state: 'stopped' })
      ])
    ).toBe('Ran 2 subagents (1 stopped)')
  })

  // The sentence is frozen into a durable journal row and replayed on every
  // reconnect, to clients that draw no roster block and reconcile nothing. It
  // may therefore only state what a dead process still makes true: the group was
  // spawned, and whatever outcome had already latched. `Kicked off` vs `Ran`
  // reports whether an outcome was recorded yet, which is a write-time fact —
  // saying `Ran` while children were in flight would assert they exited.
  it('makes no liveness claim a replayed row could not still justify', () => {
    const inFlight = subagentGroupFallbackText([
      agent({ id: 'a', state: 'working' }),
      agent({ id: 'b', state: 'working' }),
      agent({ id: 'c', state: 'completed' })
    ])

    expect(inFlight).toBe('Kicked off 3 subagents')
    expect(inFlight).not.toMatch(/\bworking\b/)
    expect(
      subagentGroupFallbackText([
        agent({ id: 'a', state: 'working' }),
        agent({ id: 'b', state: 'unverifiable' })
      ])
    ).toBe('Kicked off 2 subagents (1 unverifiable)')
  })

  it('stays quiet when nothing has gone wrong', () => {
    expect(subagentGroupFallbackText([agent({ id: 'a', state: 'working' })])).toBe(
      'Kicked off 1 subagent'
    )
    expect(subagentGroupFallbackText([agent({ id: 'a', state: 'completed' })])).toBe(
      'Ran 1 subagent'
    )
  })
})

// Both readers decide "the twin is already printing" with this, so a false
// positive silently eats a message's real prose and a false negative prints the
// roster twice. The shape must outlive a byte compare: a roster from a newer
// build names a state this build never produces.
describe('isSubagentGroupFallbackText', () => {
  it('recognizes every sentence the producer writes, including an unknown state', () => {
    expect(isSubagentGroupFallbackText(subagentGroupFallbackText([agent({})]))).toBe(true)
    expect(
      isSubagentGroupFallbackText(
        subagentGroupFallbackText([agent({ id: 'a' }), agent({ id: 'b', state: 'failed' })])
      )
    ).toBe(true)
    expect(
      isSubagentGroupFallbackText(
        subagentGroupFallbackText([agent({ id: 'a', state: 'completed' })])
      )
    ).toBe(true)
    // Not reproducible here: this build normalizes `cancelled` to `unverifiable`.
    expect(isSubagentGroupFallbackText('Ran 2 subagents (1 cancelled)')).toBe(true)
    expect(isSubagentGroupFallbackText('Kicked off 4 subagents — 2 working (1 timed-out)')).toBe(
      true
    )
  })

  // Journals written before the twin dropped its live count still hold the old
  // sentence, and those rows replay forever. A pattern that stopped matching
  // them would print every one of those rosters twice — once as the block, once
  // as prose the reader meant to drop.
  it('still recognizes the legacy twin already frozen into existing journals', () => {
    for (const legacy of [
      'Kicked off 1 subagent — 1 working',
      'Kicked off 4 subagents — 2 working',
      'Kicked off 4 subagents — 2 working (1 failed)',
      'Kicked off 4 subagents — 2 working (1 timed-out)'
    ]) {
      expect(isSubagentGroupFallbackText(legacy)).toBe(true)
    }
  })

  it('leaves prose that merely mentions subagents alone', () => {
    for (const prose of [
      'Handing the audit to two children.',
      'I kicked off 2 subagents to look at this',
      'Ran 2 subagents and then cleaned up',
      'Ran 2 subagents (1 failed) — see below',
      'Ran two subagents'
    ]) {
      expect(isSubagentGroupFallbackText(prose)).toBe(false)
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  isSubagentGroupFallbackText,
  isTerminalSubagentState,
  normalizeSubagentState,
  subagentGroupFallbackText,
  summarizeSubagentGroup,
  withoutSubagentGroupTwins
} from './native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../native-chat-types'

function agent(entry: Partial<NativeChatSubagentEntry>): NativeChatSubagentEntry {
  return { id: 'a', label: 'task', state: 'working', ...entry }
}

describe('summarizeSubagentGroup', () => {
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

  it('reports the earliest start and withholds a settled time while work continues', () => {
    const working = summarizeSubagentGroup([
      agent({ id: 'a', state: 'completed', startedAt: 50, settledAt: 80 }),
      agent({ id: 'b', state: 'working', startedAt: 20 })
    ])
    const settled = summarizeSubagentGroup([
      agent({ id: 'a', state: 'completed', startedAt: 50, settledAt: 80 }),
      agent({ id: 'b', state: 'stopped', startedAt: 20, settledAt: 95 })
    ])

    expect(working).toMatchObject({ clockStartedAt: 20, settledAt: null })
    expect(settled).toMatchObject({ clockStartedAt: 20, settledAt: 95 })
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

  // Frozen journal text replays to non-reconciling clients. Claim only spawn/latched outcomes; Kicked off versus Ran records write-time outcome presence, never liveness.
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
})

// Twin false positives hide real prose; false negatives duplicate rosters. Match shape because newer states cannot reproduce byte-for-byte here.
describe('isSubagentGroupFallbackText', () => {
  it('recognizes every sentence the producer writes, including an unknown state', () => {
    // Not reproducible here: this build normalizes `cancelled` to `unverifiable`.
    expect(isSubagentGroupFallbackText('Ran 2 subagents (1 cancelled)')).toBe(true)
    expect(isSubagentGroupFallbackText('Kicked off 4 subagents — 2 working (1 timed-out)')).toBe(
      true
    )
  })

  // Legacy dev journals retain live-count twins forever; continue matching them to avoid duplicate replay rows.
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

describe('withoutSubagentGroupTwins', () => {
  const twin = { type: 'text' as const, text: 'Ran 1 subagent' }
  const prose = { type: 'text' as const, text: 'Delegating the review.' }

  it('drops the twin only beside a group that draws', () => {
    const group = { type: 'subagent-group' as const, groupId: 'g', agents: [agent({})] }
    expect(withoutSubagentGroupTwins([twin, prose, group])).toEqual([prose, group])
    const childless = { type: 'subagent-group' as const, groupId: 'g', agents: [] }
    expect(withoutSubagentGroupTwins([twin, childless])).toEqual([twin, childless])
    expect(withoutSubagentGroupTwins([twin])).toEqual([twin])
  })
})

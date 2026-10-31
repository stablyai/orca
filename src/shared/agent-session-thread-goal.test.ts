import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from './agent-session-journal-types'
import {
  agentSessionThreadGoalElapsedSeconds,
  agentSessionThreadGoalFromReport,
  agentSessionThreadGoalStatusChange,
  currentAgentSessionThreadGoal,
  currentAgentSessionThreadGoalSourceBySequence,
  isAgentSessionThreadGoalOpen
} from './agent-session-thread-goal'

const PAYLOAD = { head: '{"goal":', byteLength: 4096, digest: 'd'.repeat(64), truncated: true }

function goal(overrides: Partial<AgentJournalThreadGoal> = {}): AgentJournalThreadGoal {
  return {
    objective: 'Ship the parser',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 30,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides
  }
}

function row(
  sequence: number,
  body: AgentJournalItemBody,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body, ...extra }
}

function goalRow(sequence: number, state: 'set' | 'cleared', value = goal()) {
  return row(sequence, {
    kind: 'status',
    text: state === 'set' ? `Goal set: ${value.objective}` : 'Goal cleared',
    providerFrame: {
      provider: 'codex',
      kind: `notification:thread/goal/${state === 'set' ? 'updated' : 'cleared'}`,
      payload: PAYLOAD
    },
    threadGoal: state === 'set' ? { state: 'set', goal: value } : { state: 'cleared' }
  })
}

describe('current thread goal', () => {
  it('reports no answer when no row records a goal transition', () => {
    expect(
      currentAgentSessionThreadGoal([
        row(1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
        row(2, { kind: 'status', text: 'Context compacted' })
      ])
    ).toBeUndefined()
  })

  it('reads the last goal row of a rendered snapshot, past later rows of other kinds', () => {
    const paused = goal({ status: 'paused' })
    expect(
      currentAgentSessionThreadGoal([
        goalRow(1, 'set'),
        goalRow(2, 'set', paused),
        row(3, { kind: 'status', text: 'Context compacted' })
      ])
    ).toEqual(paused)
  })

  it('takes the latest transition by sequence for items held unordered', () => {
    const paused = goal({ status: 'paused' })
    const latest = goalRow(5, 'set', paused)
    const unordered = new Map([
      ['b', latest],
      ['a', goalRow(2, 'set')]
    ])
    expect(currentAgentSessionThreadGoalSourceBySequence(unordered.values())).toEqual({
      item: latest,
      goal: paused
    })
    expect(currentAgentSessionThreadGoalSourceBySequence([])?.goal).toBeUndefined()
  })

  it('answers null once the latest transition cleared the goal', () => {
    expect(currentAgentSessionThreadGoal([goalRow(1, 'set'), goalRow(2, 'cleared')])).toBeNull()
  })

  it('answers null for a row written before the typed snapshot existed', () => {
    const legacy = row(3, {
      kind: 'status',
      text: 'Goal set: Ship the parser',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:thread/goal/updated',
        payload: PAYLOAD
      }
    })
    // The legacy row still supersedes the older typed one; it just cannot be read.
    expect(currentAgentSessionThreadGoal([goalRow(1, 'set'), legacy])).toBeNull()
  })

  it('ignores a subagent goal and a status this build cannot place', () => {
    const subagent = { ...goalRow(4, 'cleared'), agentId: 'child-1' }
    expect(currentAgentSessionThreadGoal([goalRow(1, 'set'), subagent])).toEqual(goal())

    // A newer provider status must not read as a known one.
    const future = goalRow(5, 'set', Object.assign(goal(), { status: 'snoozed' }))
    expect(currentAgentSessionThreadGoal([goalRow(1, 'set'), future])).toBeNull()
  })
})

describe('thread goal report epoch ownership', () => {
  it.each(['set', 'cleared'] as const)(
    'keeps the report when a %s row belongs to another epoch',
    (state) => {
      const reported = goal({ objective: 'Current conversation goal' })
      const loaded = goal({ objective: 'Previous conversation goal' })
      const report = { current: reported, contextFloor: { epoch: 'current', sequence: 2 } }
      const items = [goalRow(3, state, loaded)]
      expect.soft(agentSessionThreadGoalFromReport(items, report, 'previous')).toEqual(reported)
      expect
        .soft(agentSessionThreadGoalFromReport(items, report, 'current'))
        .toEqual(state === 'set' ? loaded : null)
    }
  )

  it('does not revive another epoch after the reported goal was cleared', () => {
    expect(
      agentSessionThreadGoalFromReport(
        [goalRow(3, 'set')],
        {
          current: null,
          contextFloor: { epoch: 'current', sequence: 2 }
        },
        'previous'
      )
    ).toBeNull()
  })
})

describe('thread goal report freshness', () => {
  it.each(['set', 'cleared'] as const)(
    'does not replace a newer %s report with stale loaded history',
    (state) => {
      const reported = state === 'set' ? goal({ objective: 'Latest goal' }) : null
      const report = { current: reported, source: { epoch: 'epoch', sequence: 5, revision: 1 } }
      expect(agentSessionThreadGoalFromReport([goalRow(3, 'set')], report, 'epoch')).toEqual(
        reported
      )
    }
  )

  it('compares revisions when accounting updates reuse the source row sequence', () => {
    const reported = goal({ tokensUsed: 20 })
    const report = { current: reported, source: { epoch: 'epoch', sequence: 3, revision: 2 } }
    expect
      .soft(agentSessionThreadGoalFromReport([goalRow(3, 'set')], report, 'epoch'))
      .toEqual(reported)
    const newer = goal({ tokensUsed: 30 })
    expect
      .soft(
        agentSessionThreadGoalFromReport(
          [{ ...goalRow(3, 'set', newer), revision: 3 }],
          report,
          'epoch'
        )
      )
      .toEqual(newer)
    expect
      .soft(agentSessionThreadGoalFromReport([goalRow(6, 'cleared')], report, 'epoch'))
      .toBeNull()
  })

  it('keeps a sourced report when another journal epoch is still loaded', () => {
    const reported = goal({ objective: 'Current epoch goal' })
    expect(
      agentSessionThreadGoalFromReport(
        [goalRow(9, 'cleared')],
        {
          current: reported,
          source: { epoch: 'current', sequence: 3, revision: 1 }
        },
        'previous'
      )
    ).toEqual(reported)
  })
})

describe('thread goal presentation facts', () => {
  it('keeps every status but complete open', () => {
    expect(isAgentSessionThreadGoalOpen(goal({ status: 'blocked' }))).toBe(true)
    expect(isAgentSessionThreadGoalOpen(goal({ status: 'complete' }))).toBe(false)
    expect(isAgentSessionThreadGoalOpen(null)).toBe(false)
  })

  it('pauses only an active goal, and resumes a paused, blocked or usage-limited one', () => {
    expect(agentSessionThreadGoalStatusChange('active')).toBe('paused')
    expect(agentSessionThreadGoalStatusChange('paused')).toBe('active')
    expect(agentSessionThreadGoalStatusChange('blocked')).toBe('active')
    expect(agentSessionThreadGoalStatusChange('usageLimited')).toBe('active')
    // A spent budget is not a pause: the provider will not resume it.
    expect(agentSessionThreadGoalStatusChange('budgetLimited')).toBeNull()
    expect(agentSessionThreadGoalStatusChange('complete')).toBeNull()
  })

  it('adds time only while an active goal has a turn running', () => {
    const now = 1_000_000 + 7_500
    const running = { startedAt: null }
    expect(agentSessionThreadGoalElapsedSeconds(goal(), now, null)).toBe(30)
    expect(agentSessionThreadGoalElapsedSeconds(goal(), now, running)).toBe(37)
    expect(agentSessionThreadGoalElapsedSeconds(goal({ status: 'paused' }), now, running)).toBe(30)
    // A report older than the turn counts from the turn's start, not across the idle gap.
    expect(agentSessionThreadGoalElapsedSeconds(goal(), now, { startedAt: now - 2_000 })).toBe(32)
    // A provider clock ahead of this one never subtracts time.
    expect(
      agentSessionThreadGoalElapsedSeconds(goal({ updatedAt: now + 5_000 }), now, running)
    ).toBe(30)
  })
})

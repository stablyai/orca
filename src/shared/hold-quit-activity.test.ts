import { describe, expect, it } from 'vitest'
import { hasHoldQuitActiveWork } from './hold-quit-activity'
import type { AgentStatusEntry } from './agent-status-types'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import { structuredAgentSessionAgentStatus } from './structured-agent-session-agent-status'
import { projectStructuredAgentSessionStatusSummary } from './structured-agent-session-projection'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { withMirroredEvidenceReceipt, AGENT_STATUS_STALE_AFTER_MS } from './agent-status-freshness'

const now = 10_000_000
const base: AgentStatusEntry = {
  paneKey: 'tab:pane',
  state: 'working',
  prompt: '',
  updatedAt: now,
  stateStartedAt: now,
  stateHistory: []
}
const child: AgentChildWorkView = {
  id: 'child',
  kind: 'agent',
  state: 'working',
  membership: 'live',
  firstObservedAt: now,
  observedAt: now,
  stoppable: true,
  invocation: { invocationId: 'turn', generation: 1 }
}
const busy = (entry: AgentStatusEntry) => hasHoldQuitActiveWork({ [entry.paneKey]: entry }, now)

describe('hold quit accepted activity projection', () => {
  it('keeps native running tools and compaction busy until the actual turn completes', () => {
    const row = (
      sequence: number,
      body: AgentJournalRenderItem['body']
    ): AgentJournalRenderItem => ({
      itemId: String(sequence),
      sequence,
      revision: 1,
      observedAt: now,
      body
    })
    const running = row(1, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn', state: 'running' }
    })
    const tool = row(2, { kind: 'tool-call', name: 'Read', input: {}, state: 'running' })
    const compaction = row(3, {
      kind: 'status',
      text: 'Compacting context',
      presentation: 'compaction'
    })
    const completed = row(4, {
      kind: 'status',
      text: 'Done',
      turnLifecycle: { turnId: 'turn', state: 'completed' }
    })
    for (const [items, expected] of [
      [[running, tool], true],
      [[running, tool, compaction], true],
      [[running, tool, compaction, completed], false]
    ] as const) {
      const summary = projectStructuredAgentSessionStatusSummary([...items])
      if (summary.status === null) {
        throw new Error('Expected a native turn status')
      }
      const projected = structuredAgentSessionAgentStatus({ ...summary, status: summary.status })
      expect(
        busy({ ...base, ...projected, mainAgent: { ...projected.mainAgent, stateStartedAt: now } })
      ).toBe(expected)
    }
  })
  it('uses working terminal evidence and rejects idle/history/restored/launch/title presence', () => {
    expect(busy(base)).toBe(true)
    for (const state of ['done', 'blocked', 'waiting'] as const) {
      expect(busy({ ...base, state })).toBe(false)
    }
    expect(busy({ ...base, restoredUnconfirmed: true })).toBe(false)
    expect(busy({ ...base, updatedAt: now - AGENT_STATUS_STALE_AFTER_MS - 1 })).toBe(false)
    for (const origin of ['launch', 'title'] as const) {
      expect(
        busy({
          ...base,
          observation: { origin, authorityId: 'host', incarnation: 1, revision: 1, observedAt: now }
        })
      ).toBe(false)
    }
  })

  it('reads actual native working and attention projections, including mixed child work', () => {
    const projected = structuredAgentSessionAgentStatus({
      status: 'working',
      childWork: [{ kind: 'agent', state: 'waiting' }]
    })
    expect(projected.state).toBe('waiting')
    expect(
      busy({ ...base, ...projected, mainAgent: { ...projected.mainAgent, stateStartedAt: now } })
    ).toBe(true)
    const finished = structuredAgentSessionAgentStatus({ status: 'idle' })
    expect(
      busy({ ...base, ...finished, mainAgent: { ...finished.mainAgent, stateStartedAt: now } })
    ).toBe(false)
    expect(
      busy({
        ...base,
        state: 'waiting',
        mainAgent: { state: 'done', stateStartedAt: now },
        children: [child, { ...child, id: 'waiting', state: 'waiting' }]
      })
    ).toBe(true)
    expect(
      busy({
        ...base,
        state: 'done',
        children: [{ ...child, membership: 'settled', state: 'done' }]
      })
    ).toBe(false)
    expect(busy({ ...base, state: 'waiting', children: [{ ...child, state: 'waiting' }] })).toBe(
      false
    )
  })

  it('preserves published live commands/monitoring and does not infer exit from unavailable child contact', () => {
    const projected = structuredAgentSessionAgentStatus({
      status: 'idle',
      childWork: [{ kind: 'command', state: 'working' }]
    })
    expect(projected.workingMode).toBe('monitoring')
    expect(
      busy({ ...base, ...projected, mainAgent: { ...projected.mainAgent, stateStartedAt: now } })
    ).toBe(true)
    expect(busy({ ...base, state: 'done', children: [{ ...child, state: 'unverifiable' }] })).toBe(
      true
    )
    expect(
      busy({
        ...base,
        state: 'done',
        subagents: [{ id: 'older-host-child', state: 'working', startedAt: now }]
      })
    ).toBe(true)
  })

  it('ages connected remote terminal facts against local receipts and honors live structured host ownership', () => {
    const remote = withMirroredEvidenceReceipt(
      { ...base, connectionId: 'remote', updatedAt: 1 },
      undefined,
      now
    )
    expect(busy(remote)).toBe(true)
    expect(hasHoldQuitActiveWork({ remote }, now + AGENT_STATUS_STALE_AFTER_MS + 1)).toBe(false)
    expect(busy({ ...base, updatedAt: 1, structuredHostOwned: true })).toBe(true)
    expect(busy({ ...remote, state: 'done' })).toBe(false)
  })
})

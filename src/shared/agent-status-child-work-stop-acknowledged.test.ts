// An accepted Stop, as the host records it: the run captured when the Stop was sent, and only it.

import { describe, expect, it } from 'vitest'
import { createAgentChildWorkAdmission } from './agent-status-child-work-admission'
import type { AgentChildWorkEvidence } from './agent-status-child-work-evidence'
import { reconcileAgentChildWorkEvidence } from './agent-status-child-work-reconciliation'
import { createAgentStatusStore } from './agent-status-store'
import { projectAgentChildWorkViews } from './agent-status-child-work-view'
import {
  agentChildWorkStopEvidence,
  agentChildWorkStopTargets
} from './agent-child-work-stop-targets'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

const parent = makeStructuredAgentStatusSubject(
  { executionHostId: 'local', wslDistro: null, workspaceId: 'ws-1', workspaceKind: 'folder' },
  'session-1'
)

function live(runId: string, observedAt = 100): AgentChildWorkEvidence {
  return {
    type: 'live',
    observedAt,
    child: {
      handle: { idKind: 'task_id', id: 'agent-1', runId },
      kind: 'agent',
      residency: 'background',
      state: 'working',
      description: 'Audit the build',
      stoppable: true
    }
  }
}

function ended(runId: string, outcome: 'succeeded' | 'failed'): AgentChildWorkEvidence {
  return {
    type: 'ended',
    observedAt: 300,
    handle: { idKind: 'task_id', id: 'agent-1', runId },
    outcome
  }
}

function harness() {
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const apply = (...evidence: AgentChildWorkEvidence[]) =>
    reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'claude', evidence })
  const views = () => {
    const records = store.getChildren(parent)
    return projectAgentChildWorkViews(
      records,
      records.flatMap((record) => store.getAliasesForChild(record.childWorkId))
    )
  }
  /** The Stop as the host sends it: targets captured first, the answer applied after. */
  const stopSent = () => agentChildWorkStopTargets(views(), 'agent-1')
  const answered = (
    targets: ReturnType<typeof stopSent>,
    outcome?: 'succeeded' | 'failed' | 'cancelled'
  ) =>
    apply(
      ...agentChildWorkStopEvidence(
        targets,
        [{ taskId: 'agent-1', ...(outcome ? { outcome } : {}) }],
        200
      )
    )
  return { apply, views, stopSent, answered }
}

describe('an accepted Stop', () => {
  it('settles its run as cancelled until the run reports how it ended', () => {
    const h = harness()
    h.apply(live('run-1'))
    h.answered(h.stopSent())
    expect(h.views()).toMatchObject([{ membership: 'settled', outcome: 'cancelled' }])
    h.apply(ended('run-1', 'succeeded'))
    expect(h.views()).toMatchObject([{ membership: 'settled', outcome: 'succeeded' }])
  })

  it('keeps the ending the run already reported', () => {
    const h = harness()
    h.apply(live('run-1'))
    const targets = h.stopSent()
    h.apply(ended('run-1', 'failed'))
    h.answered(targets)
    expect(h.views()).toMatchObject([{ membership: 'settled', outcome: 'failed' }])
  })

  it("takes the run's own ending when the answer names one", () => {
    const h = harness()
    h.apply(live('run-1'))
    h.answered(h.stopSent(), 'succeeded')
    expect(h.views()).toMatchObject([{ membership: 'settled', outcome: 'succeeded' }])
  })

  it('never settles a run that started after the Stop was sent', () => {
    const h = harness()
    h.apply(live('run-1'))
    const targets = h.stopSent()
    h.apply(ended('run-1', 'succeeded'), live('run-2', 250))
    h.answered(targets)
    expect(h.views()).toMatchObject([{ membership: 'live', state: 'working' }])
  })

  it('settles nothing for a Stop the provider did not accept', () => {
    const h = harness()
    h.apply(live('run-1'))
    h.apply(...agentChildWorkStopEvidence(h.stopSent(), [], 200))
    expect(h.views()).toMatchObject([{ membership: 'live' }])
  })
})

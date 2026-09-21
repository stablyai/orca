import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-types'
import {
  mintFleetAgentStatusEvidence,
  type FleetEvidenceBinding
} from './orchestration-fleet-agent-status-evidence'
import {
  projectOrchestrationFleet,
  type FleetDurableWorker
} from './orchestration-fleet-projection'
import { createFleetStatusIndex, statusForFleetWorker } from './orchestration-fleet-status-index'

/**
 * The observation clock and the delivery clock are two facts, and the fleet path used to carry
 * one optional field for the first with a silent `?? receivedAt` fallback to the second
 * (failure table W1-14, then RR-W-P1A when the fix turned out to be inert). The seam under test
 * is the clock, so the binding is supplied and terminal identity is proven elsewhere.
 */
const PANE_KEY = 'tab-clock:leaf-clock'
const TERMINAL_HANDLE = 'term_clock'
const NOW = 10 * AGENT_STATUS_STALE_AFTER_MS

const binding: FleetEvidenceBinding = {
  kind: 'pane',
  terminalHandle: TERMINAL_HANDLE,
  paneKey: PANE_KEY,
  processIncarnation: 'pty-clock:inc-1'
}

function payload(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    state: 'working',
    prompt: '',
    receivedAt: NOW,
    stateStartedAt: NOW,
    ...overrides
  } as AgentStatusIpcPayload
}

function worker(): FleetDurableWorker {
  return {
    dispatchId: 'disp-clock',
    taskId: 'task-clock',
    runId: 'run-clock',
    parentTaskId: null,
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    workerStage: 'prompt_delivered',
    agentTerminalHandle: TERMINAL_HANDLE,
    paneKey: PANE_KEY,
    worktreeId: 'wt-clock',
    terminalState: 'active',
    resource: null
  }
}

describe('fleet evidence clocks', () => {
  it('names the delivery arm when the producer reports no observation clock', () => {
    const evidence = mintFleetAgentStatusEvidence(payload({ receivedAt: NOW - 1 }), binding)

    expect(evidence.clock).toEqual({ kind: 'delivery', at: NOW - 1 })
    expect(
      projectOrchestrationFleet({ workers: [worker()], statuses: [evidence], now: NOW }).workers[0]
        ?.liveness
    ).toMatchObject({ verdict: 'live', source: 'agent_status' })
  })

  it('measures staleness on the observation clock a replay restamped past', () => {
    // A relay reconnect replays the cached row and restamps delivery to now; the evidence
    // underneath is an hour old and the worker is not live.
    const evidence = mintFleetAgentStatusEvidence(
      payload({
        receivedAt: NOW,
        evidenceObservedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000
      }),
      binding
    )

    expect(evidence.clock.kind).toBe('observed')
    expect(evidence.deliveredAt).toBe(NOW)
    expect(
      projectOrchestrationFleet({ workers: [worker()], statuses: [evidence], now: NOW }).workers[0]
        ?.liveness
    ).toMatchObject({ verdict: 'unverifiable', reason: 'stale_status' })
  })

  it('orders same-pane rows by delivery even when the observation clocks invert', () => {
    // Delivery order is the producer's last assertion about the pane. The replay observed
    // earlier and arrived later, and it is still the row that describes the pane now.
    const observedFirstDeliveredLast = mintFleetAgentStatusEvidence(
      payload({ receivedAt: NOW, evidenceObservedAt: NOW - 5_000, state: 'done' }),
      binding
    )
    const observedLastDeliveredFirst = mintFleetAgentStatusEvidence(
      payload({ receivedAt: NOW - 10_000, evidenceObservedAt: NOW - 1_000, state: 'working' }),
      binding
    )
    const rows = [worker()]

    const selected = statusForFleetWorker(
      rows[0]!,
      createFleetStatusIndex([observedLastDeliveredFirst, observedFirstDeliveredLast], rows)
    )

    expect(selected?.deliveredAt).toBe(NOW)
    expect(selected?.activity.state).toBe('done')
  })
})

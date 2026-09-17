import { describe, expect, it } from 'vitest'
import {
  createAgentTurnLifecycleState,
  reduceAgentTurnLifecycle,
  readAgentTurnLifecycleSnapshot
} from '../agent-turn-lifecycle'
import type { AgentTurnLifecycleEvent, AgentTurnOwner } from '../agent-turn-lifecycle'
import { providerEvidenceToLifecycleEvents } from './provider-turn-lifecycle'
import {
  readProviderInterruptAcknowledgement,
  readProviderTerminalTurnRecord,
  readProviderTurnEvidence
} from './provider-turn-evidence'

const owner: AgentTurnOwner = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-c2',
  workspaceKind: 'folder',
  runId: 'run-c2',
  attachment: { executionId: 'execution-c2' },
  provider: 'codex'
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected fixture value')
  }
  return value
}

function applyEvidence(
  state: ReturnType<typeof createAgentTurnLifecycleState>,
  evidence: Parameters<typeof providerEvidenceToLifecycleEvents>[1]
) {
  let current = state
  for (const event of providerEvidenceToLifecycleEvents(owner, evidence)) {
    current = reduceAgentTurnLifecycle(current, event).state
  }
  return current
}

function startedEvent(): Extract<AgentTurnLifecycleEvent, { kind: 'turn-started' }> {
  return {
    kind: 'turn-started',
    owner,
    evidence: { eventId: 'c2-event', producerId: 'provider:codex', observedAt: 1 },
    turnId: 'turn-1'
  }
}

describe('provider turn lifecycle bridge', () => {
  it('settles a final completion and is idempotent on late duplicate evidence', () => {
    const started = readProviderTurnEvidence({
      event: {
        paneKey: 'tab:leaf',
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        providerTurnId: 'turn-1',
        payload: { state: 'working', prompt: 'ship it', agentType: 'codex' }
      },
      observedAt: 1
    }).evidence[0]
    const completed = readProviderTurnEvidence({
      event: {
        paneKey: 'tab:leaf',
        source: 'codex',
        hookEventName: 'Stop',
        providerTurnId: 'turn-1',
        payload: { state: 'done', prompt: 'ship it', agentType: 'codex' }
      },
      observedAt: 2
    }).evidence[0]
    expect(started).toBeDefined()
    expect(completed).toBeDefined()
    let state = applyEvidence(createAgentTurnLifecycleState(owner), requireValue(started))
    state = applyEvidence(state, requireValue(completed))
    expect(readAgentTurnLifecycleSnapshot(state).turns).toContainEqual(
      expect.objectContaining({
        turnId: 'turn-1',
        phase: 'settled',
        outcome: 'completed'
      })
    )
    const duplicate = requireValue(
      providerEvidenceToLifecycleEvents(owner, requireValue(completed))[0]
    )
    expect(reduceAgentTurnLifecycle(state, duplicate).disposition).toBe('duplicate')
  })

  it('keeps interrupt input delivery separate from provider acknowledgement', () => {
    let state = reduceAgentTurnLifecycle(createAgentTurnLifecycleState(owner), startedEvent()).state
    state = reduceAgentTurnLifecycle(state, {
      kind: 'turn-interrupt-input-written',
      owner,
      turnId: 'turn-1',
      evidence: { eventId: 'input-written', producerId: 'orc:pty', observedAt: 2 }
    }).state
    expect(readAgentTurnLifecycleSnapshot(state).currentTurn).toMatchObject({
      phase: 'active',
      outcome: null,
      interruptInputWrittenAt: 2
    })
    const acknowledgement = readProviderInterruptAcknowledgement({
      source: 'codex',
      paneKey: 'tab:leaf',
      turnId: 'turn-1',
      acknowledgedBy: 'provider-hook',
      observedAt: 3
    }).evidence[0]
    state = applyEvidence(state, requireValue(acknowledgement))
    expect(readAgentTurnLifecycleSnapshot(state).turns).toContainEqual(
      expect.objectContaining({
        phase: 'settled',
        outcome: 'interrupted',
        interrupt: 'acknowledged'
      })
    )
  })

  it('allows a matching terminal record to recover a missed start', () => {
    const evidence = readProviderTerminalTurnRecord({
      source: 'codex',
      paneKey: 'tab:leaf',
      runId: owner.runId,
      executionId: owner.attachment.executionId,
      record: {
        runId: owner.runId,
        executionId: owner.attachment.executionId,
        turnId: 'turn-recovered',
        outcome: 'completed'
      },
      observedAt: 4
    }).evidence[0]
    const event = requireValue(providerEvidenceToLifecycleEvents(owner, requireValue(evidence))[0])
    const reduced = reduceAgentTurnLifecycle(createAgentTurnLifecycleState(owner), event)
    expect(reduced.disposition).toBe('accepted')
    expect(readAgentTurnLifecycleSnapshot(reduced.state).turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-recovered', phase: 'settled', outcome: 'completed' })
    )
  })

  it('does not treat an anonymous Stop as a lifecycle event', () => {
    const evidence = readProviderTurnEvidence({
      event: {
        paneKey: 'tab:leaf',
        source: 'codex',
        hookEventName: 'Stop',
        payload: { state: 'done', prompt: '', agentType: 'codex' }
      }
    })
    expect(evidence.evidence).toHaveLength(0)
  })

  it('preserves joined-child and resident-background inventory semantics', () => {
    const evidence = readProviderTurnEvidence({
      event: {
        paneKey: 'tab:leaf',
        source: 'codex',
        hookEventName: 'inventory',
        currentTurnInventory: {
          turnId: 'turn-1',
          joinedChildren: [{ workId: 'child', kind: 'joined-child', phase: 'active' }],
          residentBackground: [{ workId: 'monitor', kind: 'resident-background', phase: 'active' }]
        },
        currentTurnInventoryComplete: true,
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      }
    }).evidence[0]
    const event = requireValue(providerEvidenceToLifecycleEvents(owner, requireValue(evidence))[0])
    const turnStart = startedEvent()
    const reduced = reduceAgentTurnLifecycle(
      reduceAgentTurnLifecycle(createAgentTurnLifecycleState(owner), {
        ...turnStart,
        evidence: { eventId: 'turn-start', producerId: 'provider:codex', observedAt: 1 }
      }).state,
      event
    )
    const snapshot = readAgentTurnLifecycleSnapshot(reduced.state)
    expect(snapshot.joinedChildren).toContainEqual(
      expect.objectContaining({ workId: 'child', kind: 'joined-child' })
    )
    expect(snapshot.residentBackground).toContainEqual(
      expect.objectContaining({ workId: 'monitor', kind: 'resident-background' })
    )
  })
})

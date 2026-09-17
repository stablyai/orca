import { describe, expect, it } from 'vitest'
import {
  normalizeProviderTurnId,
  providerCurrentTurnInventory,
  readProviderInterruptAcknowledgement,
  readProviderTerminalTurnRecord,
  readProviderTurnEvidence
} from './provider-turn-evidence'
import type { ProviderTurnEvidenceInput } from './provider-turn-evidence'

function event(
  overrides: Partial<ProviderTurnEvidenceInput['event']> = {}
): ProviderTurnEvidenceInput['event'] {
  return {
    paneKey: 'tab:leaf',
    source: 'codex',
    hookEventName: 'UserPromptSubmit',
    providerTurnId: 'turn-1',
    payload: { state: 'working', prompt: 'ship it', agentType: 'codex' },
    ...overrides
  }
}

describe('provider turn evidence adapter', () => {
  it('bounds provider turn identity before retaining it across a transport', () => {
    expect(normalizeProviderTurnId(' turn-1 ')).toBe('turn-1')
    expect(normalizeProviderTurnId('x'.repeat(513))).toBeUndefined()
    const evidence = readProviderTurnEvidence({
      event: event({ paneKey: 'p'.repeat(512), providerTurnId: 't'.repeat(512) })
    }).evidence[0]
    expect(evidence?.eventId.length).toBeLessThanOrEqual(512)
  })

  it('emits an attributable start and completion for a provider turn', () => {
    const started = readProviderTurnEvidence({ event: event() })
    expect(started.evidence).toEqual([
      expect.objectContaining({
        kind: 'turn-started',
        turnId: 'turn-1',
        recordKind: 'event'
      })
    ])

    const completed = readProviderTurnEvidence({
      event: event({
        hookEventName: 'Stop',
        payload: { state: 'done', prompt: 'ship it', agentType: 'codex' }
      }),
      observedAt: 123
    })
    expect(completed.evidence).toEqual([
      expect.objectContaining({
        kind: 'turn-outcome-observed',
        turnId: 'turn-1',
        outcome: 'completed',
        observedAt: 123
      })
    ])
  })

  it('never turns an anonymous Stop into a root outcome', () => {
    const result = readProviderTurnEvidence({
      event: event({
        providerTurnId: undefined,
        providerPromptId: undefined,
        hookEventName: 'Stop'
      })
    })
    expect(result.evidence).toEqual([])
    expect(result.ignored).toBe('anonymous-outcome')
  })

  it('separates child work and resident background work from the root turn', () => {
    const result = readProviderTurnEvidence({
      event: event({
        toolAgentId: 'child-1',
        hookEventName: 'SubagentStart',
        residentBackgroundWorkIds: ['child-1']
      })
    })
    expect(result.evidence).toEqual([
      expect.objectContaining({
        kind: 'work-started',
        turnId: 'turn-1',
        workId: 'child-1',
        workKind: 'resident-background'
      })
    ])
  })

  it('requires a provider terminal marker for milestone agent_end events', () => {
    const milestone = readProviderTurnEvidence({
      event: event({
        source: 'omp',
        hookEventName: 'agent_end',
        providerTurnId: 'omp-turn',
        payload: { state: 'done', prompt: 'ship it', agentType: 'omp' }
      })
    })
    expect(milestone.evidence).toEqual([])

    const terminal = readProviderTurnEvidence({
      event: event({
        source: 'omp',
        hookEventName: 'agent_end',
        providerTurnId: 'omp-turn',
        providerTurnTerminal: true,
        payload: { state: 'done', prompt: 'ship it', agentType: 'omp' }
      })
    })
    expect(terminal.evidence).toEqual([
      expect.objectContaining({
        kind: 'turn-outcome-observed',
        turnId: 'omp-turn',
        outcome: 'completed'
      })
    ])
  })

  it('does not let a child Stop settle the root and keeps child ids distinct', () => {
    const first = readProviderTurnEvidence({
      event: event({
        toolAgentId: 'child-1',
        hookEventName: 'Stop',
        providerTurnId: undefined,
        payload: { state: 'done', prompt: 'ship it', agentType: 'codex' }
      }),
      observedAt: 10
    })
    const second = readProviderTurnEvidence({
      event: event({
        toolAgentId: 'child-2',
        hookEventName: 'Stop',
        providerTurnId: undefined,
        payload: { state: 'done', prompt: 'ship it', agentType: 'codex' }
      }),
      observedAt: 10
    })
    expect(first.evidence).toEqual([
      expect.objectContaining({
        kind: 'work-outcome-observed',
        workId: 'child-1',
        turnId: undefined,
        outcome: 'completed'
      })
    ])
    expect(second.evidence[0]?.eventId).not.toBe(first.evidence[0]?.eventId)
  })

  it('recognizes explicit provider interrupt acknowledgement only', () => {
    const result = readProviderInterruptAcknowledgement({
      source: 'claude',
      paneKey: 'tab:leaf',
      turnId: 'turn-1',
      acknowledgedBy: 'provider-hook',
      observedAt: 42
    })
    expect(result.evidence).toEqual([
      expect.objectContaining({
        kind: 'turn-interrupt-acknowledged',
        outcome: 'interrupted',
        observedAt: 42,
        recordKind: 'event'
      })
    ])
  })

  it.each(['turn/interrupted', 'interrupt_acknowledged', 'interrupted', 'cancelled'])(
    'maps %s to an attributable interrupt acknowledgement',
    (hookEventName) => {
      const result = readProviderTurnEvidence({
        event: event({
          hookEventName,
          payload: { state: 'done', prompt: 'ship it', agentType: 'codex' }
        }),
        observedAt: 43
      })
      expect(result.evidence).toEqual([
        expect.objectContaining({
          kind: 'turn-interrupt-acknowledged',
          turnId: 'turn-1',
          outcome: 'interrupted',
          observedAt: 43
        })
      ])
    }
  )

  it('requires complete current-turn inventories', () => {
    const incomplete = providerCurrentTurnInventory({ turnId: 'turn-1', joinedChildren: [] }, false)
    expect(incomplete).toBeNull()
    const complete = providerCurrentTurnInventory(
      {
        turnId: 'turn-1',
        joinedChildren: [{ id: 'child-1', phase: 'active' }],
        residentBackground: [{ id: 'monitor-1', phase: 'active' }]
      },
      true
    )
    expect(complete).toEqual({
      turnId: 'turn-1',
      joinedChildren: [{ workId: 'child-1', kind: 'joined-child', phase: 'active' }],
      residentBackground: [{ workId: 'monitor-1', kind: 'resident-background', phase: 'active' }]
    })
    expect(providerCurrentTurnInventory({ turnId: 'turn-1', joinedChildren: [] }, true)).toBeNull()
    expect(
      providerCurrentTurnInventory(
        { turnId: 'turn-1', joinedChildren: [], residentBackground: ['malformed'] },
        true
      )
    ).toBeNull()
    expect(
      providerCurrentTurnInventory(
        {
          turnId: 'turn-1',
          joinedChildren: [{ id: 'child-1', phase: 'active', outcome: 'completed' }],
          residentBackground: []
        },
        true
      )
    ).toBeNull()
    expect(
      providerCurrentTurnInventory(
        {
          turnId: 'turn-1',
          joinedChildren: [{ id: 'duplicate', phase: 'active' }],
          residentBackground: [{ id: 'duplicate', phase: 'active' }]
        },
        true
      )
    ).toBeNull()
    expect(
      providerCurrentTurnInventory(
        {
          turnId: 'turn-1',
          startedAt: -1,
          joinedChildren: [],
          residentBackground: []
        },
        true
      )
    ).toBeNull()

    const noActiveTurn = readProviderTurnEvidence({
      event: event({
        hookEventName: undefined,
        currentTurnInventory: null,
        currentTurnInventoryComplete: true
      })
    })
    expect(noActiveTurn.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'current-turn-inventory',
          inventory: null
        })
      ])
    )

    const missingInventory = readProviderTurnEvidence({
      event: event({ currentTurnInventoryComplete: true })
    })
    expect(missingInventory.evidence).toEqual([])
    expect(missingInventory.ignored).toBe('incomplete-inventory')

    const malformedInventory = readProviderTurnEvidence({
      event: event({
        currentTurnInventoryComplete: true,
        currentTurnInventory: { turnId: '', joinedChildren: [], residentBackground: [] }
      })
    })
    expect(malformedInventory.evidence).toEqual([])
    expect(malformedInventory.ignored).toBe('unsupported')
  })

  it('assigns distinct evidence identities to successive complete inventories', () => {
    const first = readProviderTurnEvidence({
      event: event({
        hookEventName: undefined,
        currentTurnInventoryComplete: true,
        currentTurnInventory: {
          turnId: 'turn-1',
          joinedChildren: [{ workId: 'child-1', kind: 'joined-child', phase: 'active' }],
          residentBackground: []
        }
      })
    }).evidence[0]
    const second = readProviderTurnEvidence({
      event: event({
        hookEventName: undefined,
        currentTurnInventoryComplete: true,
        currentTurnInventory: {
          turnId: 'turn-1',
          joinedChildren: [],
          residentBackground: []
        }
      })
    }).evidence[0]

    expect(first?.kind).toBe('current-turn-inventory')
    expect(second?.kind).toBe('current-turn-inventory')
    expect(second?.eventId).not.toBe(first?.eventId)
  })

  it('canonicalizes inventory row order for replay dedupe', () => {
    const first = readProviderTurnEvidence({
      event: event({
        hookEventName: undefined,
        currentTurnInventoryComplete: true,
        currentTurnInventory: {
          turnId: 'turn-1',
          joinedChildren: [
            { workId: 'child-z', kind: 'joined-child', phase: 'active' },
            { workId: 'child-a', kind: 'joined-child', phase: 'active' }
          ],
          residentBackground: []
        }
      })
    }).evidence[0]
    const second = readProviderTurnEvidence({
      event: event({
        hookEventName: undefined,
        currentTurnInventoryComplete: true,
        currentTurnInventory: {
          turnId: 'turn-1',
          joinedChildren: [
            { workId: 'child-a', kind: 'joined-child', phase: 'active' },
            { workId: 'child-z', kind: 'joined-child', phase: 'active' }
          ],
          residentBackground: []
        }
      })
    }).evidence[0]

    expect(second?.eventId).toBe(first?.eventId)
    expect(second?.inventory?.joinedChildren.map((work) => work.workId)).toEqual([
      'child-a',
      'child-z'
    ])
  })

  it('recovers a missed start only from a matching terminal record', () => {
    const recovered = readProviderTerminalTurnRecord({
      source: 'codex',
      paneKey: 'tab:leaf',
      runId: 'run-1',
      executionId: 'exec-1',
      record: { runId: 'run-1', executionId: 'exec-1', turnId: 'turn-2', outcome: 'completed' }
    })
    expect(recovered.evidence).toEqual([
      expect.objectContaining({
        kind: 'turn-outcome-observed',
        turnId: 'turn-2',
        recordKind: 'terminal-record'
      })
    ])

    const unrelated = readProviderTerminalTurnRecord({
      source: 'codex',
      paneKey: 'tab:leaf',
      runId: 'run-1',
      executionId: 'exec-1',
      record: { runId: 'run-other', executionId: 'exec-1', turnId: 'turn-2', outcome: 'completed' }
    })
    expect(unrelated.evidence).toEqual([])
  })
})

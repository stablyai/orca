import { describe, expect, it } from 'vitest'
import {
  formatOrchestrationCheckText,
  prepareOrchestrationCheckOutput,
  type OrchestrationCheckOutput
} from './orchestration-check-output'

describe('prepareOrchestrationCheckOutput', () => {
  it('keeps mixed read-only mail safe and current Run replies executable', () => {
    const prepared = prepareOrchestrationCheckOutput(
      {
        count: 2,
        messages: [
          {
            id: 'msg_current',
            run_id: 'run_adopted',
            delivery_contract: 'current_delivery',
            from_handle: 'term_worker',
            to_handle: 'run:run_adopted',
            subject: 'Question'
          },
          {
            id: 'msg_legacy',
            run_id: 'run_legacy_local',
            delivery_contract: 'audit_only',
            from_handle: 'term_legacy',
            to_handle: 'term_coord',
            subject: 'Old reply'
          }
        ],
        formatted: '[Reply: unsafe stale formatter output]'
      },
      'term_current_coord',
      true
    )

    expect(prepared.formatted).toContain(
      '[Reply: orca orchestration reply --id msg_current --body "..."]'
    )
    expect(prepared.formatted).not.toContain('--from run:run_adopted')
    expect(prepared.formatted).toContain(
      '[Inspection only: reply and acknowledgment are unavailable.]'
    )
    expect(prepared.formatted).not.toContain('unsafe stale formatter output')
  })
})

describe('replayed Delivery output', () => {
  const recovery = {
    waitingCount: 71,
    ackCommand: 'orca-ide orchestration check --terminal term_worker --ack delivery_old',
    guidance:
      'Process every message in this batch before acknowledging, then process the next batch returned.'
  }
  it.each([undefined, 'Message body'])(
    'renders recovery in plain and formatted output: %s',
    (formatted) => {
      const result: OrchestrationCheckOutput = {
        messages: [{ id: 'msg_one', from_handle: 'worker', subject: 'old' }],
        count: 1,
        deliveryId: 'delivery_old',
        replayed: true,
        formatted,
        replayRecovery: recovery
      }
      const output = formatOrchestrationCheckText(result, 'term_worker')
      expect(output).toContain('Delivery delivery_old (replayed)')
      expect(output).toContain('71 unread messages waiting behind this Delivery.')
      expect(output).toContain(recovery.ackCommand)
      expect(output).toContain(recovery.guidance)
      expect(output.split(recovery.ackCommand)).toHaveLength(2)
      expect(output).toContain(formatted ?? 'msg_one [status]')
    }
  )

  it('retains the optional recovery object in the actual JSON result', () => {
    const result: OrchestrationCheckOutput = {
      messages: [],
      count: 0,
      deliveryId: 'delivery_old',
      replayed: true,
      replayRecovery: recovery
    }
    expect(
      JSON.parse(JSON.stringify(prepareOrchestrationCheckOutput(result, 'term_worker', false)))
    ).toHaveProperty('replayRecovery', recovery)
  })
})

describe('formatted delivery acknowledgment', () => {
  it('retains the delivery ID above formatted message bodies', () => {
    expect(
      formatOrchestrationCheckText(
        {
          messages: [{ id: 'msg_one', from_handle: 'worker' }],
          count: 1,
          deliveryId: 'delivery_one',
          formatted: 'Message body'
        },
        'term_coord'
      )
    ).toBe('Delivery delivery_one\nMessage body')
  })
})

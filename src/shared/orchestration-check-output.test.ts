import { describe, expect, it } from 'vitest'
import {
  formatOrchestrationCheckText,
  prepareOrchestrationCheckOutput
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

describe('formatted delivery acknowledgment', () => {
  it('retains the delivery ID above formatted message bodies', () => {
    expect(
      formatOrchestrationCheckText(
        {
          messages: [{ id: 'msg_one', from_handle: 'worker' }],
          count: 1,
          deliveryId: 'delivery_one',
          deliveryAcknowledged: true,
          formatted: 'Message body'
        },
        'term_coord'
      )
    ).toBe('Delivery delivery_one\nMessage body')
  })

  it('tells the caller to ack when an older runtime did not', () => {
    expect(
      formatOrchestrationCheckText(
        {
          messages: [{ id: 'msg_one', from_handle: 'worker', subject: 'done' }],
          count: 1,
          deliveryId: 'delivery_one'
        },
        'term_coord'
      )
    ).toContain('rerun this check with --ack delivery_one.')
  })

  it('prints bodies and payloads for the plain check the wake tells agents to run', () => {
    const text = formatOrchestrationCheckText(
      {
        messages: [
          {
            id: 'msg_question',
            type: 'question',
            from_handle: 'dispatch:ctx_worker',
            to_handle: 'run:run_review',
            subject: 'Question',
            body: 'Should I preserve the old API or remove it?',
            payload: '{"taskId":"task_1","dispatchId":"ctx_worker"}'
          }
        ],
        count: 1,
        deliveryId: 'delivery_review',
        deliveryAcknowledged: true
      },
      'run:run_review'
    )
    expect(text).toContain('Should I preserve the old API or remove it?')
    expect(text).toContain('"dispatchId":"ctx_worker"')
  })
})

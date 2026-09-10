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

describe('formatOrchestrationCheckText', () => {
  it('prints message bodies and payloads before the Delivery can be acknowledged', () => {
    const output = formatOrchestrationCheckText(
      {
        deliveryId: 'delivery-1',
        count: 1,
        messages: [
          {
            id: 'message-1',
            from_handle: 'worker-1',
            to_handle: 'dispatch:dispatch-1',
            subject: 'Correction required',
            body: 'Use the exact workspace identity.',
            payload: '{"workspace":"folder:one"}'
          }
        ]
      },
      'worker-1'
    )

    expect(output).toContain('Use the exact workspace identity.')
    expect(output).toContain('{"workspace":"folder:one"}')
  })

  it('separates newer attention from the replayed Delivery acknowledgement', () => {
    const output = formatOrchestrationCheckText(
      {
        deliveryId: 'delivery-old',
        count: 1,
        messages: [{ id: 'message-old', from_handle: 'worker-1', subject: 'Old status' }],
        pendingAttentionCount: 1,
        pendingAttentionMessages: [
          {
            id: 'message-question',
            from_handle: 'worker-2',
            to_handle: 'run:run-1',
            subject: 'Current question',
            body: 'Which revision is authoritative?'
          }
        ]
      },
      'coordinator-1'
    )

    expect(output).toContain('NEW RUN ATTENTION — NOT ACKNOWLEDGED')
    expect(output).toContain('Which revision is authoritative?')
  })
})

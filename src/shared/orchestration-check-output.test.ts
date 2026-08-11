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
  it('tags each listed message with its sender liveness when the host sent it', () => {
    const text = formatOrchestrationCheckText(
      {
        count: 2,
        deliveryId: 'delivery_1',
        messages: [
          {
            id: 'msg_live',
            from_handle: 'term_worker',
            subject: 'Progress',
            type: 'status',
            senderLiveness: {
              state: 'working',
              source: 'agent_status',
              observedAt: new Date(Date.now() - 12_000).toISOString(),
              turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
              paneKey: 'tab_worker:22222222-2222-4222-8222-222222222222'
            }
          },
          {
            id: 'msg_remote',
            from_handle: 'dispatch:ctx_2',
            subject: 'Remote progress',
            type: 'status',
            senderLiveness: {
              state: 'unknown',
              source: 'federated',
              observedAt: null,
              turnStartedAt: null,
              paneKey: null
            }
          }
        ]
      },
      'term_coord'
    )

    expect(text).toContain('from=term_worker sender=working seen=12s "Progress"')
    expect(text).toContain('from=dispatch:ctx_2 sender=unknown(federated) "Remote progress"')
  })

  it('renders unchanged for a host that sends no liveness evidence', () => {
    const text = formatOrchestrationCheckText(
      {
        count: 1,
        deliveryId: 'delivery_1',
        messages: [
          { id: 'msg_old', from_handle: 'term_worker', subject: 'Progress', type: 'status' }
        ]
      },
      'term_coord'
    )

    expect(text).toBe('Delivery delivery_1\nmsg_old [status] from=term_worker "Progress"')
  })
})

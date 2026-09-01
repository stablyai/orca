import { describe, expect, it } from 'vitest'
import {
  buildOrchestrationDeliveryState,
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

  it('warns on the first unacknowledged replay and exposes hidden backlog counts', () => {
    const state = buildOrchestrationDeliveryState({
      deliveryId: 'delivery_stuck',
      blockedSince: '2026-08-17T10:00:00Z',
      deliveryCount: 2,
      mailboxUnreadCount: 26,
      pendingBehind: 24,
      replayed: true
    })

    expect(state).toMatchObject({
      blockedSince: '2026-08-17T10:00:00Z',
      pendingBehind: 24,
      mailboxUnreadCount: 26,
      checkCountDiverged: true,
      deliveryWarning: {
        code: 'delivery_fifo_blocked',
        requiredAction: 'acknowledge_delivery',
        deliveryId: 'delivery_stuck'
      }
    })
    expect(
      formatOrchestrationCheckText(
        {
          count: 2,
          messages: [
            { id: 'msg_1', from_handle: 'worker', subject: 'one' },
            { id: 'msg_2', from_handle: 'worker', subject: 'two' }
          ],
          deliveryId: 'delivery_stuck',
          ...state
        },
        'term_coord'
      )
    ).toContain(
      '[ORCHESTRATION_WARNING delivery_fifo_blocked]\nDelivery delivery_stuck was replayed without acknowledgment.'
    )
  })

  it('does not warn before a Delivery is replayed', () => {
    expect(
      buildOrchestrationDeliveryState({
        deliveryId: 'delivery_new',
        blockedSince: '2026-08-19T10:00:00Z',
        deliveryCount: 1,
        mailboxUnreadCount: 1,
        pendingBehind: 0,
        replayed: false
      })
    ).toEqual({
      blockedSince: '2026-08-19T10:00:00Z',
      pendingBehind: 0,
      mailboxUnreadCount: 1,
      checkCountDiverged: false
    })
  })

  it('warns immediately when the Delivery count hides unread mail', () => {
    expect(
      buildOrchestrationDeliveryState({
        deliveryId: 'delivery_partial',
        blockedSince: '2026-08-19T10:00:00Z',
        deliveryCount: 50,
        mailboxUnreadCount: 55,
        pendingBehind: 5,
        replayed: false
      })
    ).toMatchObject({
      checkCountDiverged: true,
      deliveryWarning: {
        code: 'delivery_fifo_blocked',
        message:
          'Delivery delivery_partial contains only part of the unread mailbox. 5 newer messages remain hidden behind this batch until it is acknowledged.'
      }
    })
  })
})

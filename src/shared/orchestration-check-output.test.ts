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
  it('labels an exact replay and reports matching mail queued behind it', () => {
    const output = formatOrchestrationCheckText(
      {
        count: 1,
        deliveryId: 'delivery_1',
        runId: 'run_1',
        replayed: true,
        queuedMatchingMessages: true,
        messages: [
          {
            id: 'msg_1',
            from_handle: 'term_worker',
            subject: 'Older status',
            type: 'status'
          }
        ]
      },
      'term_coord'
    )

    expect(output).toContain('Delivery delivery_1 [replay: unacknowledged]')
    expect(output).toContain('Other messages matching this check are queued behind this Delivery.')
    expect(output).toContain('orchestration check --run run_1 --ack delivery_1')
  })

  it('keeps delivery status explicit for formatted and mixed-version output', () => {
    expect(
      formatOrchestrationCheckText(
        {
          count: 1,
          deliveryId: 'delivery_new',
          replayed: false,
          queuedMatchingMessages: false,
          messages: [],
          formatted: 'formatted message'
        },
        'term_coord'
      )
    ).toContain('Delivery delivery_new [new]')
    const olderRuntimeOutput = formatOrchestrationCheckText(
      {
        count: 1,
        deliveryId: 'delivery_old_runtime',
        messages: [],
        formatted: 'formatted message'
      },
      'term_coord'
    )
    expect(olderRuntimeOutput).toContain(
      'Delivery delivery_old_runtime [status unavailable from older runtime]'
    )
    expect(olderRuntimeOutput).toContain(
      'Queued matching-message status is unavailable from this runtime.'
    )
  })

  // Why: the SSH path casts the payload without validating, so an off-contract value
  // must not read as a positively-established "nothing is queued".
  it('treats an off-contract queued value as unavailable rather than silence', () => {
    const output = formatOrchestrationCheckText(
      {
        count: 1,
        deliveryId: 'delivery_bad',
        replayed: true,
        queuedMatchingMessages: null as unknown as boolean,
        messages: [],
        formatted: 'formatted message'
      },
      'term_coord'
    )

    expect(output).toContain('Queued matching-message status is unavailable from this runtime.')
    expect(output).not.toContain('Other messages matching this check are queued')
  })

  it('stays silent about queued mail only when the runtime observed none', () => {
    const output = formatOrchestrationCheckText(
      {
        count: 1,
        deliveryId: 'delivery_clear',
        replayed: true,
        queuedMatchingMessages: false,
        messages: [],
        formatted: 'formatted message'
      },
      'term_coord'
    )

    expect(output).not.toContain('Queued matching-message status is unavailable')
    expect(output).not.toContain('Other messages matching this check are queued')
  })
})

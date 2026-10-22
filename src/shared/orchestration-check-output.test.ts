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
      '[Reply: orca orchestration reply --mode message --id msg_current --body "..."]'
    )
    expect(prepared.formatted).not.toContain('--from run:run_adopted')
    expect(prepared.formatted).toContain(
      '[Inspection only: reply and acknowledgment are unavailable.]'
    )
    expect(prepared.formatted).not.toContain('unsafe stale formatter output')
  })

  it('includes inspect and strict reply selectors for a question', () => {
    const prepared = prepareOrchestrationCheckOutput(
      {
        count: 2,
        formatted: '',
        messages: [
          {
            id: 'q1',
            run_id: 'r1',
            from_handle: 'dispatch:d1',
            to_handle: 'run:r1',
            type: 'question',
            body: 'Proceed?',
            payload: '{"taskId":"t1","dispatchId":"d1"}'
          },
          { id: 'old', run_id: 'run_legacy_local', from_handle: 'old' }
        ]
      },
      'coord',
      true
    )
    expect(prepared.formatted).toContain(
      'question-inspect --id q1 --run r1 --task t1 --dispatch d1 --json'
    )
    expect(prepared.formatted).toContain(
      'reply --mode question --id q1 --run r1 --task t1 --dispatch d1 --body "..."'
    )
    expect(prepared.formatted).not.toContain('--mode message --id q1')
  })

  it.each([undefined, '{broken', '{}'])(
    'omits executable question replies without exact identity (%s)',
    (payload) => {
      const prepared = prepareOrchestrationCheckOutput(
        {
          count: 2,
          formatted: '',
          messages: [
            { id: 'q1', run_id: 'r1', from_handle: 'worker', type: 'question', payload },
            { id: 'old', run_id: 'run_legacy_local', from_handle: 'old' }
          ]
        },
        'coord',
        true
      )
      expect(prepared.formatted).toContain('resolve its exact Run, Task, and Dispatch')
      expect(prepared.formatted).not.toContain('reply --')
    }
  )
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

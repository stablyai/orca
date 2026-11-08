import { describe, expect, it } from 'vitest'
import { formatOrchestrationCheckText } from './orchestration-check-output'

describe('formatted delivery acknowledgment', () => {
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

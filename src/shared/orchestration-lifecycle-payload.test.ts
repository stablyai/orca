import { describe, expect, it } from 'vitest'
import { validateLifecyclePayload } from './orchestration-lifecycle-payload'

describe('validateLifecyclePayload', () => {
  it('accepts worker completion metadata and preserves forward-compatible fields', () => {
    const result = validateLifecyclePayload(
      'worker_done',
      JSON.stringify({
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        filesModified: ['src/a.ts'],
        reportPath: 'reports/done.md',
        extensionField: true
      })
    )

    expect(result).toEqual({
      ok: true,
      payload: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        filesModified: ['src/a.ts'],
        reportPath: 'reports/done.md',
        extensionField: true
      }
    })
  })

  it.each([
    [undefined, /JSON object payload is required/],
    ['{taskId:task_1}', /expected valid JSON/],
    ['[]', /expected a JSON object/],
    [JSON.stringify({ dispatchId: 'ctx_1' }), /taskId must be a non-empty string/],
    [JSON.stringify({ taskId: 'task_1' }), /dispatchId must be a non-empty string/],
    [
      JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', filesModified: 'src/a.ts' }),
      /filesModified must be an array of strings/
    ]
  ])('rejects invalid lifecycle payload %s', (payload, message) => {
    expect(validateLifecyclePayload('worker_done', payload)).toEqual({
      ok: false,
      message: expect.stringMatching(message)
    })
  })

  it('validates heartbeat phase type', () => {
    expect(
      validateLifecyclePayload(
        'heartbeat',
        JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', phase: 2 })
      )
    ).toEqual({
      ok: false,
      message: expect.stringMatching(/phase must be a string/)
    })
  })
})

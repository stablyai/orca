import { describe, expect, it } from 'vitest'
import {
  MessageReplyParams,
  QuestionInspectParams,
  QuestionReplyParams,
  ReplyParams
} from './orchestration-params'

const selector = { id: 'q1', run: 'r1', task: 't1', dispatch: 'd1' }

describe('exact question selectors', () => {
  it('preserves legacy server reply compatibility without mode', () => {
    expect(ReplyParams.parse({ id: 'q1', body: 'yes' })).toEqual({ id: 'q1', body: 'yes' })
  })

  it('retains explicit reply modes and the exact selector', () => {
    const params = { ...selector, body: 'yes', mode: 'question' }
    expect(ReplyParams.parse(params)).toEqual(params)
    expect(ReplyParams.parse({ id: 'm1', body: 'hello', mode: 'message' }).mode).toBe('message')
    expect(QuestionReplyParams.parse(params)).toEqual(params)
  })

  it.each(['run', 'task', 'dispatch'] as const)('rejects question replies missing %s', (field) => {
    const params = { ...selector, body: 'yes', mode: 'question', [field]: undefined }
    expect(ReplyParams.safeParse(params).success).toBe(false)
    expect(QuestionReplyParams.safeParse(params).success).toBe(false)
  })

  it.each(['id', 'run', 'task', 'dispatch'] as const)('requires nonblank inspect %s', (field) => {
    expect(QuestionInspectParams.safeParse({ ...selector, [field]: '' }).success).toBe(false)
    expect(QuestionInspectParams.safeParse({ ...selector, [field]: undefined }).success).toBe(false)
  })

  it('preserves all inspect selectors and rejects unsupported modes', () => {
    expect(QuestionInspectParams.parse(selector)).toEqual(selector)
    expect(ReplyParams.safeParse({ id: 'q1', body: 'yes', mode: 'auto' }).success).toBe(false)
    expect(
      MessageReplyParams.safeParse({ id: 'm1', body: 'hello', mode: 'question' }).success
    ).toBe(false)
    expect(
      QuestionReplyParams.safeParse({ ...selector, body: 'yes', mode: 'message' }).success
    ).toBe(false)
  })
})

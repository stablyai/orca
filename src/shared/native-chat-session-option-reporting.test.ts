import { describe, expect, it } from 'vitest'
import {
  applyNativeChatReportedSessionOptions,
  createNativeChatSessionOptionRecord
} from './native-chat-session-option-state'

describe('reported session-scoped options', () => {
  it('files a session option into sessionValues, not the model bucket', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    applyNativeChatReportedSessionOptions(record, { model: 'sonnet', permissionMode: 'plan' })
    expect(record.sessionValues.permissionMode).toEqual({ value: 'plan', source: 'reported' })
    expect(record.valuesByModel.sonnet?.permissionMode).toBeUndefined()
  })

  it('keeps the session option across a model switch', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    applyNativeChatReportedSessionOptions(record, { model: 'sonnet', permissionMode: 'plan' })
    applyNativeChatReportedSessionOptions(record, { model: 'opus', permissionMode: 'plan' })
    expect(record.sessionValues.permissionMode.value).toBe('plan')
  })

  it('still records a session option when the model is unreadable', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    expect(applyNativeChatReportedSessionOptions(record, { permissionMode: 'auto' })).toBe(true)
    expect(record.sessionValues.permissionMode.value).toBe('auto')
  })

  it('leaves model-scoped options in the model bucket', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    applyNativeChatReportedSessionOptions(record, { model: 'sonnet', effort: 'high' })
    expect(record.valuesByModel.sonnet.effort).toEqual({ value: 'high', source: 'reported' })
    expect(record.sessionValues.effort).toBeUndefined()
  })
})

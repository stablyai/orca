import { describe, expect, it } from 'vitest'
import {
  cloneNativeChatSessionOptionRecord,
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'

describe('native chat session option cache', () => {
  it('starts with an empty session-scoped bucket', () => {
    expect(createNativeChatSessionOptionRecord('claude').sessionValues).toEqual({})
  })

  it('deep-clones session values so a clone never aliases the source', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.sessionValues.permissionMode = { value: 'plan', source: 'reported' }
    const clone = cloneNativeChatSessionOptionRecord(record)
    clone.sessionValues.permissionMode.value = 'manual'
    expect(record.sessionValues.permissionMode.value).toBe('plan')
  })

  it('clones a record cached before sessionValues existed', () => {
    const legacy = {
      agent: 'claude',
      valuesByModel: {}
    } as unknown as NativeChatSessionOptionRecord
    expect(cloneNativeChatSessionOptionRecord(legacy).sessionValues).toEqual({})
  })
})

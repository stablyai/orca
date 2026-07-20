import { describe, expect, it } from 'vitest'
import { isLifecycleMessageType } from './orchestration-cli-contract'

describe('isLifecycleMessageType', () => {
  it.each(['worker_done', 'heartbeat'])('accepts %s', (type) => {
    expect(isLifecycleMessageType(type)).toBe(true)
  })

  it.each([undefined, '', 'status', 'escalation', 'worker_done_extra'])(
    'rejects ordinary or malformed type %s',
    (type) => {
      expect(isLifecycleMessageType(type)).toBe(false)
    }
  )
})

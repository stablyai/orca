import { describe, expect, it } from 'vitest'
import {
  GROK_RESET_CREDIT_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from './protocol-version'

describe('Grok reset-credit runtime capability', () => {
  it('advertises the optional RPC without changing the protocol version', () => {
    expect(GROK_RESET_CREDIT_RUNTIME_CAPABILITY).toBe('accounts.grok-reset-credit.v1')
    expect(RUNTIME_CAPABILITIES).toContain(GROK_RESET_CREDIT_RUNTIME_CAPABILITY)
    expect(RUNTIME_PROTOCOL_VERSION).toBe(3)
  })
})

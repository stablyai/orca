import { describe, expect, it } from 'vitest'
import {
  resolveAutomationAuthorityHealth,
  resolveSelfExecutionHealth,
  resolveSshExecutionHealth
} from './automation-host-health'

describe('resolveAutomationAuthorityHealth', () => {
  it('reports incompatibility ahead of every other signal', () => {
    expect(
      resolveAutomationAuthorityHealth({
        reachable: false,
        compatible: false,
        queryState: 'error',
        hasData: false
      })
    ).toBe('incompatible')
  })
})

describe('execution health', () => {
  it('never borrows a status for unverified or removed registrations', () => {
    expect(resolveSshExecutionHealth('removed', 'connected', 'disconnected')).toBe('unavailable')
    expect(resolveSshExecutionHealth('unhydrated', 'connected', 'disconnected')).toBe('unknown')
  })

  it('treats an offline authority as disconnected, not gone', () => {
    expect(resolveSelfExecutionHealth('unavailable')).toBe('disconnected')
    expect(resolveSelfExecutionHealth('stale-error')).toBe('connected')
  })
})

import { describe, expect, it } from 'vitest'
import {
  resolveAutomationAuthorityHealth,
  resolveSelfExecutionHealth,
  resolveSshExecutionHealth
} from './automation-host-health'

const reachable = { reachable: true, compatible: true, hasData: true } as const

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

  it('separates first load from a background refresh', () => {
    expect(
      resolveAutomationAuthorityHealth({ ...reachable, hasData: false, queryState: 'loading' })
    ).toBe('loading')
    expect(resolveAutomationAuthorityHealth({ ...reachable, queryState: 'loading' })).toBe(
      'refreshing'
    )
    expect(resolveAutomationAuthorityHealth({ ...reachable, queryState: 'idle' })).toBe('fresh')
    expect(resolveAutomationAuthorityHealth({ ...reachable, queryState: 'error' })).toBe(
      'stale-error'
    )
  })

  it('reports an unreachable authority as unavailable', () => {
    expect(
      resolveAutomationAuthorityHealth({ ...reachable, reachable: false, queryState: 'idle' })
    ).toBe('unavailable')
  })
})

describe('execution health', () => {
  it('never borrows a status for unverified or removed registrations', () => {
    expect(resolveSshExecutionHealth('removed', 'connected', 'disconnected')).toBe('unavailable')
    expect(resolveSshExecutionHealth('unhydrated', 'connected', 'disconnected')).toBe('unknown')
  })

  it('maps every SSH status onto a distinct execution state', () => {
    expect(resolveSshExecutionHealth('authoritative', 'connected', undefined)).toBe('connected')
    expect(resolveSshExecutionHealth('authoritative', 'reconnecting', undefined)).toBe('connecting')
    expect(resolveSshExecutionHealth('authoritative', 'deploying-relay', undefined)).toBe(
      'connecting'
    )
    expect(resolveSshExecutionHealth('authoritative', 'auth-failed', undefined)).toBe(
      'disconnected'
    )
    expect(resolveSshExecutionHealth('authoritative', undefined, undefined)).toBe('unknown')
    expect(resolveSshExecutionHealth('authoritative', undefined, 'disconnected')).toBe(
      'disconnected'
    )
  })

  it('treats an offline authority as disconnected, not gone', () => {
    expect(resolveSelfExecutionHealth('unavailable')).toBe('disconnected')
    expect(resolveSelfExecutionHealth('stale-error')).toBe('connected')
  })
})

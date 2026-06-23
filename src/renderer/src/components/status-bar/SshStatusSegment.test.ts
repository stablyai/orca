import { describe, expect, it } from 'vitest'
import { isConnectedRuntimeHostState, runtimeStatusForOverall } from './SshStatusSegment'

describe('SshStatusSegment host status helpers', () => {
  it('counts connected remote servers as connected hosts', () => {
    // Why: "connected" = attached/reachable (active-agnostic), matching Settings.
    // There is no separate "available" state — a reachable host is just Connected.
    expect(runtimeStatusForOverall('connected')).toBe('connected')
    expect(isConnectedRuntimeHostState('connected')).toBe(true)
  })

  it('keeps reconnecting and disconnected remote servers out of the connected count', () => {
    expect(runtimeStatusForOverall('reconnecting')).toBe('connecting')
    expect(runtimeStatusForOverall('disconnected')).toBe('disconnected')
    expect(isConnectedRuntimeHostState('reconnecting')).toBe(false)
    expect(isConnectedRuntimeHostState('disconnected')).toBe(false)
  })
})

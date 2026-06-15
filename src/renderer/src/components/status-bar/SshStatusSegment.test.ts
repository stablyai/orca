import { describe, expect, it } from 'vitest'
import { isConnectedRuntimeHostState, runtimeStatusForOverall } from './SshStatusSegment'

describe('SshStatusSegment host status helpers', () => {
  it('counts available remote servers as connected hosts', () => {
    expect(runtimeStatusForOverall('available')).toBe('connected')
    expect(isConnectedRuntimeHostState('available')).toBe(true)
  })

  it('keeps reconnecting and disconnected remote servers out of the connected count', () => {
    expect(runtimeStatusForOverall('reconnecting')).toBe('connecting')
    expect(runtimeStatusForOverall('disconnected')).toBe('disconnected')
    expect(isConnectedRuntimeHostState('reconnecting')).toBe(false)
    expect(isConnectedRuntimeHostState('disconnected')).toBe(false)
  })
})

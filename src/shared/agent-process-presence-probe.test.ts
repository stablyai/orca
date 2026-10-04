import { describe, expect, it, vi } from 'vitest'
import {
  probeAgentProcessPresence,
  type AgentProcessObservation
} from './agent-process-presence-probe'
import type { AgentProcessIdentity } from './agent-process-presence'

const identity: AgentProcessIdentity = { pid: 4242, platform: 'linux', startTime: 'boot:100' }

describe('single-process presence evidence', () => {
  it.each<[AgentProcessObservation, string]>([
    [{ verdict: 'live', startTime: 'boot:100', zombie: false }, 'live'],
    [{ verdict: 'live', startTime: 'boot:101', zombie: false }, 'exited'],
    [{ verdict: 'live', startTime: 'boot:100', zombie: true }, 'exited'],
    [{ verdict: 'live', startTime: 'boot:100', zombie: false, stopped: true }, 'unverifiable'],
    [{ verdict: 'exited' }, 'exited'],
    [{ verdict: 'unverifiable' }, 'unverifiable']
  ])('judges %j as %s', async (observation, verdict) => {
    const read = vi.fn(async () => observation)
    expect(await probeAgentProcessPresence(identity, read, 'linux')).toBe(verdict)
    expect(read).toHaveBeenCalledExactlyOnceWith(4242)
  })

  it('keeps a timeout or permission error unverifiable', async () => {
    const read = vi.fn(async () => {
      throw new Error('EPERM')
    })
    expect(await probeAgentProcessPresence(identity, read, 'linux')).toBe('unverifiable')
  })

  it('does not inspect a missing identity or a different execution platform', async () => {
    const read = vi.fn()
    expect(await probeAgentProcessPresence(undefined, read, 'linux')).toBe('unverifiable')
    expect(await probeAgentProcessPresence(identity, read, 'win32')).toBe('unverifiable')
    expect(read).not.toHaveBeenCalled()
  })
})

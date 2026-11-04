import { describe, expect, it, vi } from 'vitest'
import {
  probeAgentProcessPresence,
  type AgentProcessObservation
} from './agent-process-presence-probe'
import type { AgentProcessIdentity } from './agent-process-presence'

const identity: AgentProcessIdentity = { pid: 4242, platform: 'linux', startTime: 'boot:100' }

describe('single-process presence evidence', () => {
  it('reports suspension only after matching the process identity', async () => {
    const observe = vi.fn()
    const read = vi.fn(async (): Promise<AgentProcessObservation> => ({
      verdict: 'live',
      startTime: identity.startTime,
      zombie: false,
      stopped: true
    }))
    expect(await probeAgentProcessPresence(identity, read, 'linux', observe)).toBe('unverifiable')
    expect(observe).toHaveBeenCalledExactlyOnceWith(true)
    observe.mockClear()
    read.mockResolvedValue({ verdict: 'unverifiable' })
    expect(await probeAgentProcessPresence(identity, read, 'linux', observe)).toBe('unverifiable')
    expect(observe).not.toHaveBeenCalled()
    read.mockResolvedValue({
      verdict: 'live',
      startTime: 'another-birth',
      zombie: false,
      stopped: true
    })
    expect(await probeAgentProcessPresence(identity, read, 'linux', observe)).toBe('exited')
    expect(observe).not.toHaveBeenCalled()
  })
})

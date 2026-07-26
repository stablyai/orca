import { describe, expect, it } from 'vitest'
import {
  retainTransientAgentStatusClearedConnection,
  TransientAgentStatusClearRegistry,
  TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS,
  TRANSIENT_AGENT_STATUS_CLEAR_MAX_ID_UTF8_BYTES
} from './transient-agent-status-clear-retention'

describe('transient agent status clear retention', () => {
  it('keeps the newest watermark for an ordinary connection', () => {
    const registry = new TransientAgentStatusClearRegistry()

    expect(registry.remember('ssh-a', 20)).toBe(20)
    expect(registry.remember('ssh-a', 10)).toBe(20)
    expect(registry.get('ssh-a')).toBe(20)
  })

  it('caps connection keys and fails closed for an evicted watermark', () => {
    const registry = new TransientAgentStatusClearRegistry()
    for (let index = 0; index <= TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS; index += 1) {
      registry.remember(`ssh-${index}`, index + 1)
    }

    expect(registry.evidence().connections).toBe(TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS)
    expect(registry.get('ssh-0')).toBe(1)
    expect(registry.get('never-seen')).toBe(1)
  })

  it('does not retain an oversized id and preserves its cutoff as a fail-closed floor', () => {
    const registry = new TransientAgentStatusClearRegistry()
    const oversized = 'x'.repeat(TRANSIENT_AGENT_STATUS_CLEAR_MAX_ID_UTF8_BYTES + 1)

    expect(registry.remember(oversized, 50)).toBeNull()
    expect(registry.evidence()).toEqual({
      connections: 0,
      idBytes: 0,
      overflowWatermark: 50
    })
    expect(registry.get(oversized)).toBe(50)
  })

  it('caps the store routing blocks while retaining the newest connection', () => {
    let retained: Record<string, true> = {}
    for (let index = 0; index <= TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS; index += 1) {
      retained = retainTransientAgentStatusClearedConnection(retained, `ssh-${index}`)
    }

    expect(Object.keys(retained)).toHaveLength(TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS)
    expect(retained['ssh-0']).toBeUndefined()
    expect(retained[`ssh-${TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS}`]).toBe(true)
  })
})

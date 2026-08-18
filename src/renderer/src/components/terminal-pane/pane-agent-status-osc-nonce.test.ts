import { beforeEach, describe, expect, it } from 'vitest'
import {
  getOrCreatePaneAgentStatusOscNonce,
  getPaneAgentStatusOscNonce,
  resetPaneAgentStatusOscNonces
} from './pane-agent-status-osc-nonce'

describe('pane agent status OSC nonce', () => {
  beforeEach(() => {
    resetPaneAgentStatusOscNonces()
  })

  it('mints 128 bits of hex entropy', () => {
    expect(getOrCreatePaneAgentStatusOscNonce('tab-1:leaf-1')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('gives different panes different nonces', () => {
    expect(getOrCreatePaneAgentStatusOscNonce('tab-1:leaf-1')).not.toBe(
      getOrCreatePaneAgentStatusOscNonce('tab-1:leaf-2')
    )
  })

  it('returns the same nonce when a pane respawns, so a live agent keeps verifying', () => {
    const first = getOrCreatePaneAgentStatusOscNonce('tab-1:leaf-1')

    expect(getOrCreatePaneAgentStatusOscNonce('tab-1:leaf-1')).toBe(first)
  })

  it('reports a pane that never spawned as unstamped', () => {
    expect(getPaneAgentStatusOscNonce('tab-1:leaf-1')).toBeNull()

    getOrCreatePaneAgentStatusOscNonce('tab-1:leaf-1')

    expect(getPaneAgentStatusOscNonce('tab-1:leaf-1')).toMatch(/^[0-9a-f]{32}$/)
  })
})

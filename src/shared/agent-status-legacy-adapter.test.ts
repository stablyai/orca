import { describe, expect, it } from 'vitest'

import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
  createAgentStatusLegacyAdapter,
  olderPeerAgentStatusLegacyMode
} from './agent-status-legacy-adapter'
import { AGENT_STATUS_RUNS_RUNTIME_CAPABILITY } from './agent-status-run-capability'

function status(paneKey: string, prompt = 'work'): AgentHookEventPayload {
  return {
    paneKey,
    connectionId: null,
    payload: { state: 'working', prompt, agentType: 'claude' }
  }
}

describe('legacy agent-status adapter', () => {
  it('refuses structured rows and keys already owned by the canonical projection', () => {
    const canonicalPaneKeys = new Set<string>()
    const adapter = createAgentStatusLegacyAdapter({
      isCanonicalPaneKey: (paneKey) => canonicalPaneKeys.has(paneKey)
    })
    const structured = { ...status('structured-pane'), structuredHost: 'owned' as const }

    expect(
      adapter.admit('main-status-update', AGENT_STATUS_2A_CURRENT_PRODUCER_MODE, structured)
    ).toBe(false)
    expect(adapter.view.size).toBe(0)

    const prior = status('canonical-pane', 'legacy before canonical publication')
    expect(adapter.admit('main-status-update', AGENT_STATUS_2A_CURRENT_PRODUCER_MODE, prior)).toBe(
      true
    )
    adapter.delete(prior.paneKey)
    canonicalPaneKeys.add(prior.paneKey)

    expect(
      adapter.admit(
        'main-status-update',
        AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
        status(prior.paneKey, 'late legacy write')
      )
    ).toBe(false)
    expect(adapter.view.has(prior.paneKey)).toBe(false)
  })

  it('does not move an existing legacy row onto a canonical projection key', () => {
    const canonicalPaneKeys = new Set<string>()
    const adapter = createAgentStatusLegacyAdapter({
      isCanonicalPaneKey: (paneKey) => canonicalPaneKeys.has(paneKey)
    })
    adapter.admit(
      'main-status-update',
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
      status('legacy-pane')
    )
    canonicalPaneKeys.add('canonical-pane')

    adapter.move('legacy-pane', 'canonical-pane')

    expect(adapter.view.has('legacy-pane')).toBe(false)
    expect(adapter.view.has('canonical-pane')).toBe(false)
  })

  it('admits an unsupported older peer but never falls back for a capable peer', () => {
    const adapter = createAgentStatusLegacyAdapter()
    const older = status('same-pane', 'older peer')
    expect(adapter.admit('main-status-update', olderPeerAgentStatusLegacyMode([]), older)).toBe(
      true
    )

    const capable = status('same-pane', 'capable peer must use canonical serving')
    expect(
      adapter.admit(
        'main-status-update',
        olderPeerAgentStatusLegacyMode([AGENT_STATUS_RUNS_RUNTIME_CAPABILITY]),
        capable
      )
    ).toBe(false)
    expect(adapter.view.get('same-pane')).toBe(older)
  })

  it('preserves and advances listing order across refresh, explicit reorder and relocation', () => {
    let nextOrder = 40
    const adapter = createAgentStatusLegacyAdapter({ nextListingOrder: () => nextOrder++ })
    adapter.admit('main-status-update', AGENT_STATUS_2A_CURRENT_PRODUCER_MODE, status('pane'))
    expect(adapter.listingOrder('pane')).toBe(40)

    adapter.admit(
      'main-status-update',
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
      status('pane', 'ordinary refresh')
    )
    expect(adapter.listingOrder('pane')).toBe(40)
    adapter.admit(
      'main-status-update',
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
      status('pane', 'refresh'),
      { moveToEnd: true }
    )
    expect(adapter.listingOrder('pane')).toBe(41)
    adapter.move('pane', 'moved-pane')
    expect(adapter.listingOrder('moved-pane')).toBe(42)

    adapter.delete('moved-pane')
    adapter.admit(
      'main-status-update',
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
      status('moved-pane', 'new lifecycle')
    )
    expect(adapter.listingOrder('moved-pane')).toBe(43)
  })
})

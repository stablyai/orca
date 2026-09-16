import { describe, expect, it } from 'vitest'

import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
  AGENT_STATUS_PERSISTED_HYDRATION_MODE,
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
  it('keeps incomplete PTY scope exclusively in the legacy region', () => {
    const adapter = createAgentStatusLegacyAdapter()
    const entry = status('pane-with-no-workspace-or-host-scope')

    expect(adapter.admit('main-status-update', AGENT_STATUS_2A_CURRENT_PRODUCER_MODE, entry)).toBe(
      true
    )
    expect(adapter.view.get(entry.paneKey)).toBe(entry)
  })

  it('refuses keys already owned by the canonical projection', () => {
    const canonicalPaneKeys = new Set<string>()
    const adapter = createAgentStatusLegacyAdapter({
      isCanonicalPaneKey: (paneKey) => canonicalPaneKeys.has(paneKey)
    })
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

  it('fails closed on malformed older-peer capability evidence', () => {
    const adapter = createAgentStatusLegacyAdapter()

    expect(
      adapter.admit(
        'main-status-update',
        olderPeerAgentStatusLegacyMode(Array.from({ length: 257 }, () => 'unknown')),
        status('malformed-peer')
      )
    ).toBe(false)
    expect(adapter.view.size).toBe(0)
  })

  it('restricts hydration admission to the named quarantine callers', () => {
    const adapter = createAgentStatusLegacyAdapter()

    expect(
      adapter.admit(
        'main-status-hydration',
        AGENT_STATUS_PERSISTED_HYDRATION_MODE,
        status('hydrated')
      )
    ).toBe(true)
    expect(
      adapter.admit(
        'main-status-update',
        AGENT_STATUS_PERSISTED_HYDRATION_MODE,
        status('wrong-caller')
      )
    ).toBe(false)
  })

  it('exposes Map reads without writable methods or mutable values', () => {
    const adapter = createAgentStatusLegacyAdapter()
    const entry = status('immutable')
    adapter.admit('main-status-update', AGENT_STATUS_2A_CURRENT_PRODUCER_MODE, entry)

    expect(adapter.view.get('immutable')).toBe(entry)
    expect(adapter.view.has('immutable')).toBe(true)
    expect(Array.from(adapter.view.keys())).toEqual(['immutable'])
    expect('set' in adapter.view).toBe(false)
    expect('delete' in adapter.view).toBe(false)
    expect(Object.isFrozen(adapter.view)).toBe(true)
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.payload)).toBe(true)
    expect(() => {
      entry.payload.prompt = 'mutated outside the adapter'
    }).toThrow()
    expect(adapter.view.get('immutable')?.payload.prompt).toBe('work')
  })

  it('assigns listing order once per live row and preserves it across refresh and move', () => {
    let nextOrder = 40
    const adapter = createAgentStatusLegacyAdapter({ nextListingOrder: () => nextOrder++ })
    adapter.admit('main-status-update', AGENT_STATUS_2A_CURRENT_PRODUCER_MODE, status('pane'))
    expect(adapter.listingOrder('pane')).toBe(40)

    adapter.admit(
      'main-status-update',
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
      status('pane', 'refresh'),
      { moveToEnd: true }
    )
    expect(adapter.listingOrder('pane')).toBe(40)
    adapter.move('pane', 'moved-pane')
    expect(adapter.listingOrder('moved-pane')).toBe(40)

    adapter.delete('moved-pane')
    adapter.admit(
      'main-status-update',
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
      status('moved-pane', 'new lifecycle')
    )
    expect(adapter.listingOrder('moved-pane')).toBe(41)
  })
})

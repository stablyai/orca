import { describe, expect, it } from 'vitest'
import {
  authStalledPaneKeysForProviders,
  providersThatCameBack
} from './agent-stall-provider-recovery-trigger'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { AppState } from '@/store'

function provider(status: 'ok' | 'error' | 'idle') {
  return { provider: 'claude', session: null, weekly: null, updatedAt: 0, error: null, status }
}

function limits(claude: ReturnType<typeof provider> | null): RateLimitState {
  return { claude } as unknown as RateLimitState
}

describe('providersThatCameBack', () => {
  it('reports a provider that stopped refusing — the trace of a sign-in', () => {
    expect(providersThatCameBack(limits(provider('error')), limits(provider('ok')))).toEqual([
      'claude'
    ])
  })

  it('stays quiet while a provider keeps answering', () => {
    expect(providersThatCameBack(limits(provider('ok')), limits(provider('ok')))).toEqual([])
  })

  it('stays quiet while a provider is still refusing', () => {
    expect(providersThatCameBack(limits(provider('error')), limits(provider('idle')))).toEqual([])
  })

  it('does not read a first successful read as a recovery', () => {
    // Nothing had failed yet, so there is nothing to continue.
    expect(providersThatCameBack(limits(null), limits(provider('ok')))).toEqual([])
    expect(providersThatCameBack(null, limits(provider('ok')))).toEqual([])
  })
})

function stallState(
  entries: { paneKey: string; cause: 'auth' | 'network' | 'rate-limit'; agentType?: string }[]
): Pick<AppState, 'agentStallByPaneKey' | 'agentStatusByPaneKey'> {
  return {
    agentStallByPaneKey: Object.fromEntries(
      entries.map((entry) => [
        entry.paneKey,
        { paneKey: entry.paneKey, cause: entry.cause, signature: 'x', observedAt: 0 }
      ])
    ),
    agentStatusByPaneKey: Object.fromEntries(
      entries
        .filter((entry) => entry.agentType)
        .map((entry) => [entry.paneKey, { agentType: entry.agentType }])
    )
  } as unknown as Pick<AppState, 'agentStallByPaneKey' | 'agentStatusByPaneKey'>
}

describe('authStalledPaneKeysForProviders', () => {
  it('continues only the panes waiting on a sign-in', () => {
    const state = stallState([
      { paneKey: 'tab:leaf-auth', cause: 'auth', agentType: 'claude' },
      { paneKey: 'tab:leaf-net', cause: 'network', agentType: 'claude' },
      { paneKey: 'tab:leaf-limit', cause: 'rate-limit', agentType: 'claude' }
    ])

    expect(authStalledPaneKeysForProviders(state, ['claude'])).toEqual(['tab:leaf-auth'])
  })

  it('leaves a pane on another provider alone', () => {
    const state = stallState([{ paneKey: 'tab:leaf', cause: 'auth', agentType: 'codex' }])

    expect(authStalledPaneKeysForProviders(state, ['claude'])).toEqual([])
  })

  it('includes an agent Orca cannot map, since one sign-in usually fixes the rest', () => {
    const state = stallState([{ paneKey: 'tab:leaf', cause: 'auth', agentType: 'aider' }])

    expect(authStalledPaneKeysForProviders(state, ['claude'])).toEqual(['tab:leaf'])
  })

  it('does nothing when no provider came back', () => {
    const state = stallState([{ paneKey: 'tab:leaf', cause: 'auth', agentType: 'claude' }])

    expect(authStalledPaneKeysForProviders(state, [])).toEqual([])
  })
})

/**
 * Continues login-stalled agents the moment their provider answers again,
 * instead of waiting out a backoff that is only guessing when the user signed
 * back in.
 *
 * The backoff ladder still exists for the case nobody is watching; this is the
 * fast path for the case somebody just fixed the thing that broke.
 */

import { useAppStore, type AppState } from '@/store'
import { recoverStalledAgentPanes } from '@/lib/recover-stalled-agent-panes'
import { isAutomaticAgentStallRecoveryEnabled } from '@/lib/stalled-agent-recovery-scheduler'
import {
  rateLimitProviderForAgentType,
  type AgentStallRateLimitProvider
} from '../../../shared/agent-stall-rate-limit-provider'
import type { RateLimitState } from '../../../shared/rate-limit-types'

const WATCHED_PROVIDERS: readonly AgentStallRateLimitProvider[] = [
  'claude',
  'codex',
  'gemini',
  'opencodeGo',
  'grok',
  'antigravity'
]

/** Providers that were refusing and are now answering — the observable trace of
 *  a sign-in, since the credentials themselves never reach the renderer. */
export function providersThatCameBack(
  previous: RateLimitState | null | undefined,
  next: RateLimitState | null | undefined
): AgentStallRateLimitProvider[] {
  if (!next) {
    return []
  }
  return WATCHED_PROVIDERS.filter((provider) => {
    const before = previous?.[provider]
    // A provider Orca had never read is not a recovery: it has not failed yet.
    return Boolean(before) && before?.status !== 'ok' && next[provider]?.status === 'ok'
  })
}

/** Auth-stalled panes whose agent belongs to one of `providers`. */
export function authStalledPaneKeysForProviders(
  state: Pick<AppState, 'agentStallByPaneKey' | 'agentStatusByPaneKey'>,
  providers: readonly AgentStallRateLimitProvider[]
): string[] {
  if (providers.length === 0) {
    return []
  }
  const wanted = new Set(providers)
  return Object.values(state.agentStallByPaneKey)
    .filter((observation) => {
      if (observation.cause !== 'auth') {
        return false
      }
      const agentType = state.agentStatusByPaneKey[observation.paneKey]?.agentType
      const provider = rateLimitProviderForAgentType(agentType)
      // Why recover an unmapped agent too: Orca cannot tell which provider it
      // uses, and a sign-in that fixed one CLI usually fixed the shared login.
      return provider === null || wanted.has(provider)
    })
    .map((observation) => observation.paneKey)
}

type ProviderRecoveryDeps = {
  recover?: typeof recoverStalledAgentPanes
}

export function installAgentStallProviderRecovery(deps: ProviderRecoveryDeps = {}): () => void {
  const recover = deps.recover ?? recoverStalledAgentPanes
  let previousRateLimits = useAppStore.getState().rateLimits

  return useAppStore.subscribe((state) => {
    if (state.rateLimits === previousRateLimits) {
      return
    }
    const recovered = providersThatCameBack(previousRateLimits, state.rateLimits)
    previousRateLimits = state.rateLimits
    if (recovered.length === 0 || !isAutomaticAgentStallRecoveryEnabled(state.settings)) {
      return
    }
    const paneKeys = authStalledPaneKeysForProviders(state, recovered)
    if (paneKeys.length === 0) {
      return
    }
    // force: the whole point is that the fence the backoff was holding — "has
    // the user signed in yet?" — has just been answered.
    void recover({ force: true, paneKeys, causes: ['auth'] }).catch((error) => {
      console.warn('[agent-stall] provider-recovery continue failed:', error)
    })
  })
}

import type { PreloadApi } from '../../../../preload/api-types'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { noopUnsubscribe } from './web-storage'

export function createRateLimitsApi(): NonNullable<Partial<PreloadApi>['rateLimits']> {
  const empty: RateLimitState = {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
  return {
    get: () => Promise.resolve(empty),
    refresh: () => Promise.resolve(empty),
    refreshCodexForTarget: () => Promise.resolve(empty),
    // Why: web clients don't own local Codex auth; report the safe no-credit outcome since redemption is desktop-only.
    consumeCodexResetCredit: () => Promise.resolve({ outcome: 'noCredit', state: empty }),
    refreshClaudeForTarget: () => Promise.resolve(empty),
    setPollingInterval: () => Promise.resolve(),
    fetchInactiveClaudeAccounts: () => Promise.resolve(),
    fetchInactiveCodexAccounts: () => Promise.resolve(),
    refreshMiniMax: () => Promise.resolve(empty),
    refreshGrok: () => Promise.resolve(empty),
    onUpdate: () => noopUnsubscribe
  }
}

import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { Translate } from '@/i18n/use-translate'
import { createPendingProviderSnapshot } from '../composition/status-bar-provider-visibility'
import {
  describeUnverifiableOwner,
  mapProviders,
  ownerPlaceholderSnapshot,
  type OwnerUsageFailureReason
} from './owner-usage-rate-limits'

/** One account-owned provider of a WSL distro owner, resolved on its own so a live slot never blanks. */
export type WslProviderState =
  | { kind: 'value'; reading: ProviderRateLimits | null }
  | { kind: 'pending' }
  | { kind: 'failed'; reason: OwnerUsageFailureReason }

/** A WSL distro's usage: Claude and Codex per provider; other slots fail closed, never showing this device's numbers. */
export function wslOwnerRateLimits(
  local: RateLimitState,
  distro: string,
  providers: Record<'claude' | 'codex', WslProviderState>,
  copy: { ownerLabel: string; notShown: string },
  t?: Translate
): RateLimitState {
  const resolve = (key: 'claude' | 'codex'): ProviderRateLimits | null => {
    const state = providers[key]
    if (state.kind === 'value') {
      return state.reading
    }
    return state.kind === 'pending'
      ? createPendingProviderSnapshot(key)
      : ownerPlaceholderSnapshot(key, describeUnverifiableOwner(copy.ownerLabel, state.reason, t), {
          unverifiableOwner: true
        })
  }
  const target = { runtime: 'wsl', wslDistro: distro } as const
  return createEmptyRateLimitState({
    ...mapProviders((key) =>
      local[key] ? ownerPlaceholderSnapshot(key, copy.notShown, { unverifiableOwner: true }) : null
    ),
    claude: resolve('claude'),
    codex: resolve('codex'),
    claudeTarget: target,
    codexTarget: target
  })
}

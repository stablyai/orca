import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { watchProviderAccounts } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** The host is still reading Codex; its state is about to change again. */
export const CODEX_RESET_AUTHORITY_READING = 'reading'

/** What the host's reset offer is built from; timestamps and other providers are left out. */
function codexResetAuthorityKey(
  rateLimits: RateLimitState | null | undefined,
  selectedAccountId: string | null | undefined
): string {
  if (rateLimits?.codex?.status === 'fetching') {
    return CODEX_RESET_AUTHORITY_READING
  }
  const credits = rateLimits?.codex?.rateLimitResetCredits
  return [
    rateLimits?.codexTarget.runtime,
    rateLimits?.codexTarget.wslDistro,
    rateLimits?.codex?.status,
    credits?.availableCount,
    credits?.nextExpiresAt,
    selectedAccountId
  ].join('|')
}

/** The chat host's Codex reset authority, observed only while `watching`; null otherwise. */
export function useNativeChatUsageResetAuthority(
  target: RuntimeClientTarget,
  watching: boolean
): string | null {
  const local = useAppStore((s) =>
    watching && target.kind === 'local'
      ? codexResetAuthorityKey(
          s.rateLimits,
          s.settings?.activeCodexManagedAccountIdsByRuntime?.host ??
            s.settings?.activeCodexManagedAccountId
        )
      : null
  )
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [remote, setRemote] = useState<{ environmentId: string; key: string } | null>(null)
  useEffect(() => {
    if (!watching || environmentId === null) {
      return
    }
    // The paired host's accounts stream carries its rate limits and selection as they change.
    const watcher = watchProviderAccounts(
      { kind: 'environment', environmentId },
      {
        onSnapshot: (snapshot) =>
          setRemote({
            environmentId,
            key: codexResetAuthorityKey(
              snapshot.rateLimits,
              snapshot.codex.activeAccountIdsByRuntime?.host ?? snapshot.codex.activeAccountId
            )
          }),
        // Losing the stream leaves the card as it is; Retry still reads the host directly.
        onError: () => {}
      }
    )
    return () => watcher.close()
  }, [environmentId, watching])
  if (!watching) {
    return null
  }
  return target.kind === 'local'
    ? local
    : remote?.environmentId === environmentId
      ? remote.key
      : null
}

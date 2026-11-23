import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../../shared/agent-accounts/managed-account-types'
import { watchProviderAccounts } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'

export function useAccountsPaneOwnerWatch(args: {
  scopeEnvironmentId: string | null
  setCodexAccounts: (state: CodexRateLimitAccountsState) => void
  setCodexAccountsLoaded: (loaded: boolean) => void
  setClaudeAccounts: (state: ClaudeRateLimitAccountsState) => void
  setOwnerUsage: (
    usage: { environmentId: string; rateLimits: RateLimitState | null } | null
  ) => void
}): void {
  const {
    scopeEnvironmentId,
    setCodexAccounts,
    setCodexAccountsLoaded,
    setClaudeAccounts,
    setOwnerUsage
  } = args
  useEffect(() => {
    const owner: RuntimeClientTarget = scopeEnvironmentId
      ? { kind: 'environment', environmentId: scopeEnvironmentId }
      : { kind: 'local' }
    // Keep remote watchers open for streamed usage after the initial snapshot; local watchers resolve once.
    const watcher = watchProviderAccounts(owner, {
      onSnapshot: (snapshot) => {
        // Failed-provider rosters are substituted empty data; retain prior state and keep the loaded gate shut.
        if (!snapshot.failedProviders?.includes('codex')) {
          setCodexAccounts(snapshot.codex)
          setCodexAccountsLoaded(true)
        }
        if (!snapshot.failedProviders?.includes('claude')) {
          setClaudeAccounts(snapshot.claude)
        }
        if (scopeEnvironmentId) {
          setOwnerUsage({ environmentId: scopeEnvironmentId, rateLimits: snapshot.rateLimits })
        }
      },
      onClosedAfterSnapshot: () => setOwnerUsage(null),
      onError: (error) => {
        toast.error(
          translate(
            'auto.components.settings.AccountsPane.loadAccountsFailed',
            'Could not load provider accounts.'
          ),
          { description: String((error as Error)?.message ?? error) }
        )
      }
    })
    return () => {
      watcher.close()
    }
  }, [
    scopeEnvironmentId,
    setCodexAccounts,
    setCodexAccountsLoaded,
    setClaudeAccounts,
    setOwnerUsage
  ])
}

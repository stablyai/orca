import { useEffect, useState } from 'react'
import type { DeepSeekAccountStatus } from '../../../shared/deepseek-balance'
import { unsupportedDeepSeekAccount } from '../../../shared/deepseek-balance'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { useAppStore } from '../store'
import { readDeepSeekAccount } from '../runtime/deepseek-account-client'
import {
  watchProviderAccounts,
  type ProviderAccountsWatcher
} from '../runtime/runtime-provider-accounts-client'

export function useDeepSeekAccount(environmentId: string | null, unsupportedRuntime = false) {
  const localLimits = useAppStore((s) => s.rateLimits.deepseek)
  const localAccount = useAppStore((s) => s.rateLimits.deepseekAccount)
  const [observed, setObserved] = useState<{
    scope: string | null
    status: DeepSeekAccountStatus
    limits: ProviderRateLimits | null
  } | null>(null)
  const [failedScope, setFailedScope] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (unsupportedRuntime) {
      return
    }
    let closed = false
    let watcher: ProviderAccountsWatcher | null = null
    const target = environmentId
      ? { kind: 'environment' as const, environmentId }
      : { kind: 'local' as const }
    void readDeepSeekAccount(target)
      .then((next) => {
        if (closed) {
          return
        }
        setFailedScope(undefined)
        setObserved({ scope: environmentId, status: next, limits: null })
        if (environmentId && next.supported) {
          watcher = watchProviderAccounts(
            { activeRuntimeEnvironmentId: environmentId },
            {
              onSnapshot: ({ rateLimits }) => {
                if (closed) {
                  return
                }
                setFailedScope(undefined)
                setObserved({
                  scope: environmentId,
                  status: rateLimits?.deepseekAccount ?? unsupportedDeepSeekAccount(),
                  limits: rateLimits?.deepseek ?? null
                })
              },
              onError: () => {
                if (!closed) {
                  setFailedScope(environmentId ?? 'local')
                }
              }
            }
          )
        }
      })
      .catch(() => {
        if (!closed) {
          setFailedScope(environmentId ?? 'local')
        }
      })
    return () => {
      closed = true
      watcher?.close()
    }
  }, [environmentId, unsupportedRuntime])

  const current = observed?.scope === environmentId ? observed : null
  const account = unsupportedRuntime
    ? unsupportedDeepSeekAccount()
    : environmentId
      ? (current?.status ?? null)
      : (localAccount ?? current?.status ?? null)
  const limits =
    unsupportedRuntime || !account?.supported
      ? null
      : environmentId
        ? (current?.limits ?? null)
        : (localLimits ?? null)
  const setStatus = (next: DeepSeekAccountStatus): void =>
    setObserved({ scope: environmentId, status: next, limits: current?.limits ?? null })
  return { account, limits, readFailed: failedScope === (environmentId ?? 'local'), setStatus }
}

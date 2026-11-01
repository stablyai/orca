import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageHistoryProvider, UsageHistoryRow } from '../../../../shared/usage-history-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import {
  resolveUsageHistoryTarget,
  supportsUsageHistory,
  usageHistoryApi,
  usageHistoryAccounts
} from './usage-history-client'

export type UsageHistorySource = {
  provider: UsageHistoryProvider
  status: 'loading' | 'ready' | 'unsupported' | 'error'
  enabled: boolean
  isScanning: boolean
  lastScanCompletedAt: number | null
  error: string | null
  historyToday?: string
  needsRescan?: boolean
  rows: UsageHistoryRow[]
}

const PROVIDERS: readonly UsageHistoryProvider[] = ['claude', 'codex', 'opencode', 'muse']

function initialSources(): UsageHistorySource[] {
  return PROVIDERS.map((provider) => ({
    provider,
    status: 'loading',
    enabled: false,
    isScanning: false,
    lastScanCompletedAt: null,
    error: null,
    rows: []
  }))
}

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

type OwnedUsageHistory = {
  ownerKey: string
  sources: UsageHistorySource[]
  accounts: ProviderAccountsSnapshot | null
}

export function useUsageHistory(target: RuntimeClientTarget = LOCAL_TARGET) {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const ownerKey = environmentId === null ? 'local' : `environment:${environmentId}`
  const [owned, setOwned] = useState<OwnedUsageHistory>(() => ({
    ownerKey,
    sources: initialSources(),
    accounts: null
  }))
  const [isRefreshing, setRefreshing] = useState(false)
  const generation = useRef(0)

  const load = useCallback(
    async (force = false, enable?: UsageHistoryProvider) => {
      const request = ++generation.current
      let owner: RuntimeClientTarget =
        environmentId === null ? LOCAL_TARGET : { kind: 'environment', environmentId }
      setRefreshing(true)
      setOwned((current) =>
        current.ownerKey === ownerKey
          ? current
          : { ownerKey, sources: initialSources(), accounts: null }
      )
      const isCurrent = () => generation.current === request
      const update = (provider: UsageHistoryProvider, patch: Partial<UsageHistorySource>): void => {
        if (isCurrent()) {
          setOwned((current) =>
            current.ownerKey === ownerKey
              ? {
                  ...current,
                  sources: current.sources.map((source) =>
                    source.provider === provider ? { ...source, ...patch } : source
                  )
                }
              : current
          )
        }
      }
      try {
        owner = await resolveUsageHistoryTarget(owner)
        if (!isCurrent()) {
          return
        }
        const supported = await supportsUsageHistory(owner)
        if (!isCurrent()) {
          return
        }
        if (!supported) {
          PROVIDERS.forEach((provider) =>
            update(provider, {
              status: 'unsupported',
              enabled: false,
              rows: [],
              error: null,
              isScanning: false,
              lastScanCompletedAt: null,
              needsRescan: false
            })
          )
          setRefreshing(false)
          return
        }
        void usageHistoryAccounts(owner)
          .then((accounts) => {
            if (isCurrent()) {
              setOwned((current) =>
                current.ownerKey === ownerKey ? { ...current, accounts } : current
              )
            }
          })
          .catch(() => {})
      } catch (error) {
        PROVIDERS.forEach((provider) =>
          update(provider, {
            status: 'error',
            isScanning: false,
            error: error instanceof Error ? error.message : String(error)
          })
        )
        if (isCurrent()) {
          setRefreshing(false)
        }
        return
      }
      await Promise.all(
        PROVIDERS.map(async (provider) => {
          const api = usageHistoryApi(owner, provider)
          try {
            if (provider === enable) {
              await api.setEnabled({ enabled: true })
              if (!isCurrent()) {
                return
              }
            }
            const read = async (): Promise<boolean> => {
              const snapshot = await api.getSnapshot({
                scope: 'all',
                range: 'all',
                limit: 0,
                includeHistory: true
              })
              if (!isCurrent()) {
                return false
              }
              if (!snapshot) {
                update(provider, { status: 'unsupported', rows: [], isScanning: false })
                return false
              }
              update(provider, {
                status: snapshot.history === undefined ? 'unsupported' : 'ready',
                historyToday: snapshot.historyToday,
                enabled: snapshot.scanState.enabled,
                isScanning: snapshot.scanState.isScanning,
                lastScanCompletedAt: snapshot.scanState.lastScanCompletedAt,
                error: snapshot.scanState.lastScanError,
                needsRescan: snapshot.historyNeedsRescan === true,
                rows:
                  snapshot.scanState.enabled && !snapshot.historyNeedsRescan
                    ? (snapshot.history ?? [])
                    : []
              })
              return snapshot.history !== undefined && snapshot.scanState.enabled
            }
            if (await read()) {
              await api.refresh({ force })
              if (isCurrent()) {
                await read()
              }
            }
          } catch (error) {
            update(provider, {
              status: 'error',
              isScanning: false,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        })
      )
      if (generation.current === request) {
        setRefreshing(false)
      }
    },
    [environmentId, ownerKey]
  )

  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  useEffect(() => {
    void load()
    return invalidate
  }, [load, invalidate])

  return {
    sources: owned.ownerKey === ownerKey ? owned.sources : initialSources(),
    accounts: owned.ownerKey === ownerKey ? owned.accounts : null,
    isRefreshing: owned.ownerKey !== ownerKey || isRefreshing,
    refresh: () => load(true),
    enable: (provider: UsageHistoryProvider) => load(true, provider)
  }
}

import type { BackendConnectionPurpose } from '../../../../shared/backend-service-contract'
import type { UsageFailure } from '../../store/slices/usage/usage-provider-types'
import { mergeUsageFailure } from '../../store/slices/usage/usage-provider-slice-state'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageHistoryProvider, UsageHistoryRow } from '../../../../shared/usage-history-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
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
  failure?: UsageFailure | null
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
    failure: null,
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
  const pendingCommands = useRef<Map<UsageHistoryProvider, 'refresh' | 'setting'> | null>(null)

  const load = useCallback(
    async (force = false, enable?: UsageHistoryProvider, purpose?: BackendConnectionPurpose) => {
      const request = ++generation.current
      const commands = new Map<UsageHistoryProvider, 'refresh' | 'setting'>()
      pendingCommands.current = commands
      let owner: RuntimeClientTarget =
        environmentId === null ? LOCAL_TARGET : { kind: 'environment', environmentId }
      setRefreshing(true)
      setOwned((current) =>
        current.ownerKey === ownerKey
          ? current
          : { ownerKey, sources: initialSources(), accounts: null }
      )
      const isCurrent = () => generation.current === request
      const finish = (): void => {
        if (isCurrent()) {
          pendingCommands.current = null
          setRefreshing(false)
        }
      }
      const update = (
        provider: UsageHistoryProvider,
        patch:
          | Partial<UsageHistorySource>
          | ((source: UsageHistorySource) => Partial<UsageHistorySource>)
      ): void => {
        if (isCurrent()) {
          setOwned((current) =>
            current.ownerKey === ownerKey
              ? {
                  ...current,
                  sources: current.sources.map((source) =>
                    source.provider === provider
                      ? { ...source, ...(typeof patch === 'function' ? patch(source) : patch) }
                      : source
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
          finish()
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
        finish()
        return
      }
      await Promise.all(
        PROVIDERS.map(async (provider) => {
          const settled = (action: 'refresh' | 'setting'): void => {
            commands.delete(provider)
            update(provider, (source) => ({
              failure: mergeUsageFailure(source.failure ?? null, { [action]: false })
            }))
          }
          try {
            const api = usageHistoryApi(owner, provider)
            if (provider === enable) {
              commands.set(provider, 'setting')
              await api.setEnabled({ enabled: true })
              settled('setting')
              if (!isCurrent()) {
                return
              }
            }
            const read = async (): Promise<void> => {
              const snapshot = await api.getSnapshot(
                { scope: 'all', range: 'all', limit: 0, includeHistory: true },
                purpose
              )
              if (!isCurrent()) {
                return
              }
              if (!snapshot) {
                update(provider, { status: 'unsupported', rows: [], isScanning: false })
                return
              }
              update(provider, (source) => ({
                status: snapshot.history === undefined ? 'unsupported' : 'ready',
                failure: mergeUsageFailure(source.failure ?? null, {
                  terminal: false,
                  read: false
                }),
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
              }))
            }
            if (force) {
              commands.set(provider, 'refresh')
              await api.refresh({ force: true })
              settled('refresh')
              if (!isCurrent()) {
                return
              }
            }
            await read()
          } catch (error) {
            const pending = commands.get(provider)
            commands.delete(provider)
            update(provider, (source) => ({
              status: 'error',
              isScanning: false,
              error: error instanceof Error ? error.message : String(error),
              failure: mergeUsageFailure(source.failure ?? null, {
                read: true,
                ...(pending === 'refresh' ? { refresh: true } : {}),
                ...(pending === 'setting' ? { setting: true } : {})
              })
            }))
          }
        })
      )
      finish()
    },
    [environmentId, ownerKey]
  )

  const invalidate = useCallback(() => {
    generation.current++
    pendingCommands.current = null
  }, [])
  useEffect(() => {
    let active = true
    const api = environmentId === null ? usageHistoryApi(LOCAL_TARGET, 'claude') : null
    const unsubscribe = api?.onConnectionChanged?.((connected, detail) => {
      if (!active) {
        return
      }
      if (connected) {
        if (!detail?.initial && pendingCommands.current === null) {
          void load(false, undefined, 'recovery')
        }
        return
      }
      const pending = new Map(pendingCommands.current ?? [])
      invalidate()
      setRefreshing(false)
      setOwned((current) =>
        current.ownerKey === ownerKey
          ? {
              ...current,
              sources: current.sources.map((source) => ({
                ...source,
                status: 'error',
                isScanning: false,
                failure: mergeUsageFailure(source.failure ?? null, {
                  terminal: detail?.unavailable === true,
                  read: true,
                  ...(pending?.get(source.provider) === 'refresh' ? { refresh: true } : {}),
                  ...(pending?.get(source.provider) === 'setting' ? { setting: true } : {})
                })
              }))
            }
          : current
      )
    })
    void load(false, undefined, 'recovery')
    return () => {
      active = false
      unsubscribe?.()
      invalidate()
    }
  }, [environmentId, ownerKey, load, invalidate])

  return {
    sources: owned.ownerKey === ownerKey ? owned.sources : initialSources(),
    accounts: owned.ownerKey === ownerKey ? owned.accounts : null,
    isRefreshing: owned.ownerKey !== ownerKey || isRefreshing,
    refresh: () => load(true),
    enable: (provider: UsageHistoryProvider) => load(true, provider)
  }
}

import { visibleAccountHostId } from '@/lib/workspace/ownership/visible-account-surface'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  applyOwnerAccountsSnapshot,
  currentOwnerAccountsStream,
  readOwnerAccounts,
  subscribeOwnerAccounts
} from '@/runtime/provider-accounts/observations/owner-accounts-stream'
import { useActiveAccountOwner } from '@/runtime/provider-accounts/ownership/use-active-account-owner'
import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import {
  readWslOwnerUsage,
  refreshWslOwnerUsage,
  subscribeWslOwnerUsage
} from '@/runtime/provider-accounts/observations/wsl-owner-usage-store'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '../../../store/index'
import {
  isOwnerReturnToLocal,
  resolveOwnerUsageRateLimits,
  type OwnerUsageState
} from './owner-usage-rate-limits'
import {
  getCodexStatusActiveId,
  scopeCodexAuthFailure
} from '../accounts/status-bar-codex-accounts'

// Why: accounts.list({refreshUsage}) waits for the host's provider fetches.
const REMOTE_USAGE_REFRESH_TIMEOUT_MS = 30_000
// Why: the distro read has no host stream to push updates, so the visible owner re-reads per poll cadence.
const WSL_OWNER_USAGE_REFRESH_MS = 5 * 60 * 1000
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** A remote host (SSH-managed server or paired Orca) that owns the shown usage. */
export type RemoteUsageOwner = {
  environmentId: string | null
  /** Set when this desktop stands in for a WSL host's distro, whose accounts it manages. */
  wslDistro?: string
  label: string
}

/** The Settings host that owns the shown usage, so its accounts open beside the bar's numbers. */
export function getUsageOwnerHostScope(
  remoteOwner: RemoteUsageOwner | null
): RuntimeClientTarget | null {
  return remoteOwner
    ? remoteOwner.environmentId
      ? { kind: 'environment', environmentId: remoteOwner.environmentId }
      : // Why: this desktop manages a WSL host's distro accounts, so its Settings own them.
        remoteOwner.wslDistro
        ? LOCAL_TARGET
        : null
    : LOCAL_TARGET
}

export type OwnerUsageRateLimits = {
  /** Whose accounts the shown usage belongs to; account switchers list this owner's accounts. */
  owner: AccountOwner | null
  rateLimits: RateLimitState
  accounts: ProviderAccountsSnapshot | null
  /** Null when this device owns the shown usage. */
  remoteOwner: RemoteUsageOwner | null
  /** Forces the owning host to re-read usage; null when this device owns it. */
  refreshRemote: (() => Promise<void>) | null
}

/** Read provider usage from the focused workspace’s account owner, including that host’s own remote snapshot. */
export function useOwnerUsageRateLimits(local: RateLimitState): OwnerUsageRateLimits {
  // Why: route by the focused workspace's owner, never by the Active Server setting.
  const owner = useActiveAccountOwner(LOCAL_TARGET)
  const visibleHostLabel = useAppStore((s) => {
    const host = visibleAccountHostId(s)
    return host ? selectExecutionHostDisplayLabel(s, host) : null
  })
  const previousOwner = useRef(owner)

  useEffect(() => {
    const returnedToLocal = isOwnerReturnToLocal(previousOwner.current, owner)
    previousOwner.current = owner
    if (returnedToLocal) {
      void window.api.rateLimits
        .refreshOnOwnerReturn()
        .catch((error) => console.warn('[usage] owner-return refresh failed', error))
    }
  }, [owner])

  return useAccountOwnerUsage(owner, local, visibleHostLabel)
}

/**
 * One owner's accounts and usage: this device's store, the host's own accounts stream, or — for
 * a WSL host this desktop stands in for — a direct read of that distro's runtime. A null
 * (unproven) owner has no account transport, so it shows unavailable usage.
 */
export function useAccountOwnerUsage(
  owner: AccountOwner | null,
  local: RateLimitState,
  hostLabel: string | null = null
): OwnerUsageRateLimits {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const wslDistro = owner?.wslHostDistro ?? null
  const unavailable = owner === null
  const ownerId = owner && !wslDistro ? runtimeTargetEnvironmentId(owner.target) : null
  const ownerName = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === ownerId)?.name ?? null
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      ownerId ? subscribeOwnerAccounts(ownerId, listener) : () => undefined,
    [ownerId]
  )
  const read = useCallback(() => (ownerId ? readOwnerAccounts(ownerId) : null), [ownerId])
  const owned = useSyncExternalStore(subscribe, read, read)
  const subscribeWsl = useCallback((listener: () => void) => subscribeWslOwnerUsage(listener), [])
  const readWsl = useCallback(() => readWslOwnerUsage(wslDistro), [wslDistro])
  const wslUsage = useSyncExternalStore(subscribeWsl, readWsl, readWsl)

  useEffect(() => {
    if (!wslDistro) {
      return
    }
    const readDistro = (): void => {
      void refreshWslOwnerUsage(wslDistro).catch((error) =>
        console.warn('[usage] WSL owner usage read failed', error)
      )
    }
    readDistro()
    const timer = setInterval(readDistro, WSL_OWNER_USAGE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [wslDistro])

  const refreshRemote = useCallback(async () => {
    if (wslDistro) {
      await refreshWslOwnerUsage(wslDistro, true)
      return
    }
    if (!ownerId) {
      return
    }
    const startedOn = currentOwnerAccountsStream(ownerId)
    try {
      const snapshot = await callRuntimeRpc<ProviderAccountsSnapshot>(
        { kind: 'environment', environmentId: ownerId },
        'accounts.list',
        { refreshUsage: true },
        { timeoutMs: REMOTE_USAGE_REFRESH_TIMEOUT_MS }
      )
      // Keyed by host and stream, so a refresh that outlives an owner switch never becomes current.
      applyOwnerAccountsSnapshot(ownerId, snapshot, startedOn)
    } catch {
      // Why: a slow forced refresh is not loss of contact; the stream owns reachability.
    }
  }, [ownerId, wslDistro])

  const remoteOwner = useMemo<RemoteUsageOwner | null>(
    () =>
      unavailable || ownerId || wslDistro
        ? {
            environmentId: ownerId,
            ...(wslDistro ? { wslDistro } : {}),
            label:
              hostLabel ||
              (wslDistro ? `WSL ${wslDistro}` : null) ||
              ownerName?.trim() ||
              t('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server')
          }
        : null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    [ownerId, ownerName, hostLabel, unavailable, wslDistro, languageRevision, t]
  )

  const ownerState = useMemo<OwnerUsageState>(() => {
    if (!remoteOwner) {
      return { kind: 'local' }
    }
    if (unavailable) {
      return {
        kind: 'remote-unverifiable',
        ownerLabel: remoteOwner.label,
        reason: 'unsupported-owner',
        lastKnown: null
      }
    }
    if (wslDistro) {
      if (!wslUsage) {
        return { kind: 'remote-pending' }
      }
      return wslUsage.failed
        ? {
            kind: 'remote-unverifiable',
            ownerLabel: remoteOwner.label,
            reason: 'unreachable',
            lastKnown: null
          }
        : { kind: 'remote', ownerLabel: remoteOwner.label, rateLimits: wslUsage.rateLimits }
    }
    if (!owned) {
      return { kind: 'remote-pending' }
    }
    if (owned.failure) {
      return {
        kind: 'remote-unverifiable',
        ownerLabel: remoteOwner.label,
        reason: owned.failure,
        lastKnown: owned.snapshot?.rateLimits ?? null
      }
    }
    return owned.snapshot?.rateLimits
      ? { kind: 'remote', ownerLabel: remoteOwner.label, rateLimits: owned.snapshot.rateLimits }
      : { kind: 'remote-pending' }
  }, [remoteOwner, owned, unavailable, wslDistro, wslUsage])

  const rateLimits = useMemo(
    () => resolveOwnerUsageRateLimits(local, ownerState, t),
    [local, ownerState, t]
  )
  const authFailureAccount = rateLimits.codex?.usageMetadata?.authFailureAccount
  const localActiveCodexId = useAppStore((s) => {
    if (ownerId || !authFailureAccount || !s.settings) {
      return null
    }
    return getCodexStatusActiveId(
      {
        activeAccountId: s.settings.activeCodexManagedAccountId ?? null,
        activeAccountIdsByRuntime: s.settings.activeCodexManagedAccountIdsByRuntime
      },
      authFailureAccount
    )
  })
  const hostCodexAccounts = owned?.snapshot?.codex
  const scopedRateLimits = useMemo(() => {
    if (!rateLimits.codex || !authFailureAccount) {
      return rateLimits
    }
    const target = rateLimits.codexTarget
    const matchesRuntime =
      authFailureAccount.runtime === target.runtime &&
      (!target.wslDistro || authFailureAccount.wslDistro === target.wslDistro)
    const activeAccountId = !ownerId
      ? localActiveCodexId
      : hostCodexAccounts && getCodexStatusActiveId(hostCodexAccounts, authFailureAccount)
    const codex = scopeCodexAuthFailure(
      rateLimits.codex,
      matchesRuntime ? (activeAccountId ?? null) : null
    )
    return codex === rateLimits.codex ? rateLimits : { ...rateLimits, codex }
  }, [authFailureAccount, hostCodexAccounts, localActiveCodexId, ownerId, rateLimits])
  return {
    owner,
    rateLimits: scopedRateLimits,
    accounts: ownerId ? (owned?.snapshot ?? null) : null,
    remoteOwner,
    refreshRemote: ownerId || unavailable || wslDistro ? refreshRemote : null
  }
}

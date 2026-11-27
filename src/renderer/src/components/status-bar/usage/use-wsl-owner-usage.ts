import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { isOrcaWindowForegroundFocused } from '@/attention/orca-window-foreground-focus'
import {
  isUnattributedRetryPending,
  readWslProviderUsage,
  requestWslOwnerUsage,
  subscribeWslOwnerUsage,
  wslProviderUsageKey,
  type WslProviderSelection,
  type WslProviderUsageEntry
} from '@/runtime/provider-accounts/observations/wsl-owner-usage-store'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitState,
  RuntimeTargetUsageProvider
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useAppStore } from '../../../store/index'
import { getClaudeStatusActiveId } from '../accounts/status-bar-claude-accounts'
import { getCodexStatusActiveId } from '../accounts/status-bar-codex-accounts'
import type { OwnerUsageState } from './owner-usage-rate-limits'
import { wslOwnerRateLimits, type WslProviderState } from './wsl-owner-rate-limits'

// Why: a timer firing a hair early must still find the reading due.
const EXPIRY_SLACK_MS = 50

function isDistroTarget(target: RateLimitRuntimeTarget, distro: string): boolean {
  return target.runtime === 'wsl' && target.wslDistro?.toLowerCase() === distro.toLowerCase()
}

function selectedAccount(
  settings: GlobalSettings | null,
  distro: string,
  provider: RuntimeTargetUsageProvider
): string | null {
  const target = { runtime: 'wsl', wslDistro: distro } as const
  return provider === 'claude'
    ? (getClaudeStatusActiveId(
        {
          accounts: [],
          activeAccountId: settings?.activeClaudeManagedAccountId ?? null,
          activeAccountIdsByRuntime: settings?.activeClaudeManagedAccountIdsByRuntime
        },
        target
      ) ?? null)
    : getCodexStatusActiveId(
        {
          activeAccountId: settings?.activeCodexManagedAccountId ?? null,
          activeAccountIdsByRuntime: settings?.activeCodexManagedAccountIdsByRuntime
        },
        target
      )
}

function useEntry(key: string | null): WslProviderUsageEntry | null {
  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeWslOwnerUsage(key, listener) : () => undefined),
    [key]
  )
  const read = useCallback(() => readWslProviderUsage(key), [key])
  return useSyncExternalStore(subscribe, read, read)
}

function providerState(
  live: boolean,
  liveReading: ProviderRateLimits | null,
  entry: WslProviderUsageEntry | null
): WslProviderState {
  if (live) {
    return { kind: 'value', reading: liveReading }
  }
  if (!entry || entry.usage.kind === 'pending') {
    return { kind: 'pending' }
  }
  return entry.usage.kind === 'failed'
    ? { kind: 'failed', reason: entry.usage.reason }
    : { kind: 'value', reading: entry.usage.reading }
}

/** A WSL host's distro usage, read on this desktop without switching its own fetch target. */
export function useWslOwnerUsage(
  distro: string | null,
  local: RateLimitState,
  ownerLabel: string
): { state: OwnerUsageState | null; refresh: () => Promise<void> } {
  const t = useTranslate()
  // Why: a switch changes these, so the distro re-reads without any switcher calling in.
  const claudeAccount = useAppStore((s) =>
    distro ? selectedAccount(s.settings, distro, 'claude') : null
  )
  const codexAccount = useAppStore((s) =>
    distro ? selectedAccount(s.settings, distro, 'codex') : null
  )
  // Why: a provider the desktop already fetches for this distro uses its live state, not a copy.
  const claudeLive = distro !== null && isDistroTarget(local.claudeTarget, distro)
  const codexLive = distro !== null && isDistroTarget(local.codexTarget, distro)
  const claudeKey =
    distro && !claudeLive ? wslProviderUsageKey(distro, 'claude', claudeAccount) : null
  const codexKey = distro && !codexLive ? wslProviderUsageKey(distro, 'codex', codexAccount) : null
  const claudeEntry = useEntry(claudeKey)
  const codexEntry = useEntry(codexKey)
  const selection = useMemo<WslProviderSelection>(
    () => ({
      ...(claudeKey ? { claude: claudeAccount } : {}),
      ...(codexKey ? { codex: codexAccount } : {})
    }),
    [claudeKey, codexKey, claudeAccount, codexAccount]
  )

  useEffect(() => {
    if (!distro || !(claudeKey || codexKey)) {
      return
    }
    const read = (): void => void requestWslOwnerUsage(distro, selection)
    read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [distro, claudeKey, codexKey, selection])

  // Why: piggyback on the desktop poller instead of running a separate idle timer. Every poll
  // cycle pushes a new state object even when provider stamps are gated or null (WSL-only
  // credentials); the non-forced request is a local TTL check, so extra pushes cost no IPC.
  const lastLocalRef = useRef(local)
  useEffect(() => {
    if (local === lastLocalRef.current) {
      return
    }
    lastLocalRef.current = local
    if (distro && (claudeKey || codexKey) && isOrcaWindowForegroundFocused()) {
      void requestWslOwnerUsage(distro, selection)
    }
  }, [distro, claudeKey, codexKey, selection, local])

  // Why: retry only when main could not attribute a mid-switch read, never on a settled reading.
  const retryAt = Math.min(
    isUnattributedRetryPending(claudeEntry) ? (claudeEntry?.expiresAt ?? Infinity) : Infinity,
    isUnattributedRetryPending(codexEntry) ? (codexEntry?.expiresAt ?? Infinity) : Infinity
  )
  useEffect(() => {
    if (!distro || !Number.isFinite(retryAt)) {
      return
    }
    const delay = Math.max(0, retryAt - Date.now()) + EXPIRY_SLACK_MS
    // Why skip in the background: the focus listener re-reads when the window comes back.
    const reread = (): void => {
      if (isOrcaWindowForegroundFocused()) {
        void requestWslOwnerUsage(distro, selection)
      }
    }
    const timer = setTimeout(reread, delay)
    return () => clearTimeout(timer)
  }, [distro, selection, retryAt])

  const state = useMemo<OwnerUsageState | null>(() => {
    if (!distro) {
      return null
    }
    const providers = {
      claude: providerState(claudeLive, local.claude, claudeEntry),
      codex: providerState(codexLive, local.codex, codexEntry)
    }
    const notShown = t(
      'auto.components.status.bar.UsageRosterPanel.wslUsageNotShown',
      "WSL usage isn't shown yet"
    )
    const copy = { ownerLabel, notShown }
    return {
      kind: 'remote',
      ownerLabel,
      rateLimits: wslOwnerRateLimits(local, distro, providers, copy, t)
    }
  }, [distro, local, claudeLive, codexLive, claudeEntry, codexEntry, ownerLabel, t])

  const { claudeTarget, codexTarget } = local
  const refresh = useCallback(async () => {
    if (!distro) {
      return
    }
    // Why: a live provider refreshes through the desktop's own poller; the rest re-read the distro.
    await Promise.all([
      requestWslOwnerUsage(distro, selection, true),
      claudeLive ? window.api.rateLimits.refreshClaudeForTarget(claudeTarget) : null,
      codexLive ? window.api.rateLimits.refreshCodexForTarget(codexTarget) : null
    ])
  }, [distro, selection, claudeLive, codexLive, claudeTarget, codexTarget])

  return { state, refresh }
}

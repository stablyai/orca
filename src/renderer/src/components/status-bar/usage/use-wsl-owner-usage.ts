import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import {
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
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useAppStore } from '../../../store/index'
import { getClaudeStatusActiveId } from '../accounts/status-bar-claude-accounts'
import { getCodexStatusActiveId } from '../accounts/status-bar-codex-accounts'
import type { OwnerUsageState } from './owner-usage-rate-limits'
import { wslOwnerRateLimits, type WslProviderState } from './wsl-owner-rate-limits'

// Why: a timer firing a hair early must still find the reading due.
const EXPIRY_SLACK_MS = 50
// Why: a longer delay overflows setTimeout and fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1

function isDistroTarget(target: RateLimitRuntimeTarget, distro: string): boolean {
  return target.runtime === 'wsl' && target.wslDistro?.toLowerCase() === distro.toLowerCase()
}

function selectedClaude(settings: GlobalSettings | null, distro: string): string | null {
  const state = {
    accounts: [],
    activeAccountId: settings?.activeClaudeManagedAccountId ?? null,
    activeAccountIdsByRuntime: settings?.activeClaudeManagedAccountIdsByRuntime
  }
  return getClaudeStatusActiveId(state, { runtime: 'wsl', wslDistro: distro }) ?? null
}

function selectedCodex(settings: GlobalSettings | null, distro: string): string | null {
  const state = {
    activeAccountId: settings?.activeCodexManagedAccountId ?? null,
    activeAccountIdsByRuntime: settings?.activeCodexManagedAccountIdsByRuntime
  }
  return getCodexStatusActiveId(state, { runtime: 'wsl', wslDistro: distro })
}

function useEntry(key: string | null): WslProviderUsageEntry | null {
  const read = useCallback(() => readWslProviderUsage(key), [key])
  return useSyncExternalStore(subscribeWslOwnerUsage, read, read)
}

function providerState(
  live: boolean,
  liveReading: ProviderRateLimits | null,
  entry: WslProviderUsageEntry | null
): WslProviderState {
  if (live) {
    return { kind: 'value', reading: liveReading }
  }
  if (!entry) {
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
  const claudeAccount = useAppStore((s) => (distro ? selectedClaude(s.settings, distro) : null))
  const codexAccount = useAppStore((s) => (distro ? selectedCodex(s.settings, distro) : null))
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

  // Why: re-read when the soonest reading expires, so a window that stays focused never freezes.
  const expiresAt = Math.min(claudeEntry?.expiresAt ?? Infinity, codexEntry?.expiresAt ?? Infinity)
  useEffect(() => {
    if (!distro || !Number.isFinite(expiresAt)) {
      return
    }
    const delay = Math.min(Math.max(0, expiresAt - Date.now()) + EXPIRY_SLACK_MS, MAX_TIMER_MS)
    const timer = setTimeout(() => void requestWslOwnerUsage(distro, selection), delay)
    return () => clearTimeout(timer)
  }, [distro, selection, expiresAt])

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

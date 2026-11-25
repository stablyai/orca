import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import {
  readWslOwnerUsage,
  requestWslOwnerUsage,
  subscribeWslOwnerUsage,
  wslOwnerUsageKey
} from '@/runtime/provider-accounts/observations/wsl-owner-usage-store'
import type {
  RateLimitRuntimeTarget,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useAppStore } from '../../../store/index'
import { getClaudeStatusActiveId } from '../accounts/status-bar-claude-accounts'
import { getCodexStatusActiveId } from '../accounts/status-bar-codex-accounts'
import { keepAccountOwnedProviders, type OwnerUsageState } from './owner-usage-rate-limits'

function isDistroTarget(target: RateLimitRuntimeTarget, distro: string): boolean {
  return target.runtime === 'wsl' && target.wslDistro?.toLowerCase() === distro.toLowerCase()
}

function selectionKey(settings: GlobalSettings | null, distro: string): string {
  const target = { runtime: 'wsl', wslDistro: distro } as const
  const claude = {
    accounts: [],
    activeAccountId: settings?.activeClaudeManagedAccountId ?? null,
    activeAccountIdsByRuntime: settings?.activeClaudeManagedAccountIdsByRuntime
  }
  const codex = {
    activeAccountId: settings?.activeCodexManagedAccountId ?? null,
    activeAccountIdsByRuntime: settings?.activeCodexManagedAccountIdsByRuntime
  }
  return wslOwnerUsageKey(distro, {
    claude: getClaudeStatusActiveId(claude, target) ?? null,
    codex: getCodexStatusActiveId(codex, target)
  })
}

/** A WSL host's distro usage, read on this desktop without switching its own fetch target. */
export function useWslOwnerUsage(
  distro: string | null,
  local: RateLimitState,
  ownerLabel: string
): { state: OwnerUsageState | null; refresh: () => Promise<void> } {
  const t = useTranslate()
  // Why: a switch changes this key, so the distro re-reads without any switcher calling in.
  const key = useAppStore((s) => (distro ? selectionKey(s.settings, distro) : null))
  // Why: when the desktop already fetches for this distro, its live state beats any copy.
  const claudeLive = distro !== null && isDistroTarget(local.claudeTarget, distro)
  const codexLive = distro !== null && isDistroTarget(local.codexTarget, distro)
  const readKey = claudeLive && codexLive ? null : key

  useEffect(() => {
    if (!distro || !readKey) {
      return
    }
    const read = (): void => void requestWslOwnerUsage(distro, readKey)
    read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [distro, readKey])

  const read = useCallback(() => readWslOwnerUsage(readKey), [readKey])
  const usage = useSyncExternalStore(subscribeWslOwnerUsage, read, read)

  const state = useMemo<OwnerUsageState | null>(() => {
    if (!distro) {
      return null
    }
    if (usage?.kind === 'failed') {
      return { kind: 'remote-unverifiable', ownerLabel, reason: usage.reason, lastKnown: null }
    }
    if (readKey && !usage) {
      return { kind: 'remote-pending' }
    }
    const base = usage?.read.rateLimits ?? local
    const rateLimits = {
      ...base,
      claude: claudeLive ? local.claude : base.claude,
      codex: codexLive ? local.codex : base.codex
    }
    const notShown = t(
      'auto.components.status.bar.UsageRosterPanel.wslUsageNotShown',
      "WSL usage isn't shown yet"
    )
    return {
      kind: 'remote',
      ownerLabel,
      rateLimits: keepAccountOwnedProviders(local, rateLimits, notShown)
    }
  }, [distro, readKey, usage, ownerLabel, local, claudeLive, codexLive, t])

  const refresh = useCallback(async () => {
    if (distro) {
      await (readKey
        ? requestWslOwnerUsage(distro, readKey, true)
        : window.api.rateLimits.refresh())
    }
  }, [distro, readKey])

  return { state, refresh }
}

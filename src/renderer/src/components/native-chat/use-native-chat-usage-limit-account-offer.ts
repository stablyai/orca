// What a chat stopped by its usage limit offers instead of waiting: another account with room, or
// adding one. Reads the same rosters and usage figures as the status bar's account switcher.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'
import { fetchProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import {
  getClaudeStatusActiveId,
  resolveClaudeStatusAccountState
} from '../status-bar/status-bar-claude-accounts'
import {
  getCodexStatusActiveId,
  resolveCodexStatusAccountState
} from '../status-bar/status-bar-codex-accounts'
import {
  selectClaudeAccountLikeStatusBar,
  selectCodexAccountLikeStatusBar
} from '../status-bar/provider-account-selection'
import type { CodexStatusRuntimeTarget } from '../status-bar/status-bar-runtime-targets'

export type NativeChatUsageLimitAccountOffer =
  | {
      kind: 'switch'
      account: string
      percentLeft: number
      switching: boolean
      switchAndContinue: () => void
    }
  | { kind: 'add'; agent: 'claude' | 'codex'; addAccount: () => void }

type AgentRoster =
  | { agent: 'codex'; state: CodexRateLimitAccountsState }
  | { agent: 'claude'; state: ClaudeRateLimitAccountsState }
type Candidate = { id: string; email: string; percentLeft: number }

const HOST: CodexStatusRuntimeTarget = { runtime: 'host', wslDistro: null }

/** Room left in the account's tightest window; null when its usage is unknown. */
export function usageLimitPercentLeft(limits: ProviderRateLimits | null): number | null {
  const windows = [limits?.session, limits?.weekly, limits?.monthly].filter(
    (window) => window != null
  )
  if (windows.length === 0) {
    return null
  }
  return 100 - Math.max(...windows.map((window) => clampUsedPercent(window.usedPercent)))
}

type RosterAccount = { id: string; email: string; wsl: boolean; needsSignIn: boolean }

function rosterAccounts(roster: AgentRoster): RosterAccount[] {
  return roster.agent === 'claude'
    ? roster.state.accounts.map((account) => ({
        id: account.id,
        email: account.email,
        wsl: account.managedAuthRuntime === 'wsl',
        needsSignIn: account.needsSignIn === true
      }))
    : roster.state.accounts.map((account) => ({
        id: account.id,
        email: account.email,
        wsl: account.managedHomeRuntime === 'wsl',
        needsSignIn: false
      }))
}

/** The host account with the most room, other than the active one; null when none has room. */
export function pickUsageLimitAccount(
  accounts: readonly RosterAccount[],
  activeId: string | null,
  usage: readonly InactiveAccountUsage[]
): Candidate | null {
  let best: Candidate | null = null
  for (const account of accounts) {
    if (account.id === activeId || account.wsl || account.needsSignIn) {
      continue
    }
    const percentLeft = usageLimitPercentLeft(
      usage.find((entry) => entry.accountId === account.id)?.rateLimits ?? null
    )
    if (percentLeft !== null && percentLeft > 0 && (!best || percentLeft > best.percentLeft)) {
      best = { id: account.id, email: account.email, percentLeft }
    }
  }
  return best
}

function followingAgent(agent: AgentType): 'claude' | 'codex' | null {
  return agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : null
}

export function useNativeChatUsageLimitAccountOffer(input: {
  agent: AgentType
  target: RuntimeClientTarget
  wslDistro: string | null
  /** A usage limit stopped the chat and Continue is on offer. */
  blocked: boolean
  continueUsageLimit: () => void
}): NativeChatUsageLimitAccountOffer | null {
  const { target, blocked, continueUsageLimit } = input
  const agent = followingAgent(input.agent)
  // Why local only: inactive-account usage is cached for this machine's accounts, as in the status bar.
  const enabled = blocked && agent !== null && target.kind === 'local' && !input.wslDistro
  const settings = useAppStore((s) => s.settings)
  const usage = useAppStore((s) =>
    agent === 'claude' ? s.rateLimits.inactiveClaudeAccounts : s.rateLimits.inactiveCodexAccounts
  )
  const [roster, setRoster] = useState<AgentRoster | null>(null)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    if (!enabled || agent === null) {
      return
    }
    let current = true
    void fetchProviderAccountsSnapshot(target).then(
      (snapshot) => {
        if (current && !snapshot.failedProviders?.includes(agent)) {
          setRoster(
            agent === 'claude'
              ? { agent, state: snapshot.claude }
              : { agent, state: snapshot.codex }
          )
        }
      },
      (error: unknown) => console.error('Failed to load accounts for a usage-limit switch:', error)
    )
    const store = useAppStore.getState()
    void (agent === 'claude'
      ? store.fetchInactiveClaudeAccountUsage()
      : store.fetchInactiveCodexAccountUsage())
    return () => {
      current = false
    }
  }, [enabled, agent, target])

  // Settings hold this machine's selection as it changes; the roster adds what only the host reads.
  const resolved = useMemo((): AgentRoster | null => {
    if (roster?.agent !== agent) {
      return null
    }
    return roster.agent === 'claude'
      ? { agent: 'claude', state: resolveClaudeStatusAccountState(settings, roster.state, null) }
      : { agent: 'codex', state: resolveCodexStatusAccountState(settings, roster.state, null) }
  }, [roster, agent, settings])
  const activeId = !resolved
    ? null
    : resolved.agent === 'claude'
      ? getClaudeStatusActiveId(resolved.state, HOST)
      : getCodexStatusActiveId(resolved.state, HOST)
  const accounts = resolved ? rosterAccounts(resolved) : []
  const candidate = resolved ? pickUsageLimitAccount(accounts, activeId, usage) : null
  const hasOtherAccount = accounts.some((account) => account.id !== activeId)

  const switchAndContinue = useCallback(() => {
    if (!candidate || !resolved || switching) {
      return
    }
    setSwitching(true)
    const selection = { owner: target, accountId: candidate.id, target: HOST }
    const selected =
      resolved.agent === 'claude'
        ? selectClaudeAccountLikeStatusBar({ ...selection, accountState: resolved.state })
        : selectCodexAccountLikeStatusBar({ ...selection, accountState: resolved.state })
    void selected
      .then(() => continueUsageLimit())
      .catch((error: unknown) =>
        console.error('Failed to switch accounts past a usage limit:', error)
      )
      .finally(() => setSwitching(false))
  }, [candidate, resolved, switching, target, continueUsageLimit])

  const addAccount = useCallback(() => {
    const store = useAppStore.getState()
    store.openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: `accounts-${agent}` })
    store.openSettingsPage()
  }, [agent])

  if (!enabled || agent === null || !resolved) {
    return null
  }
  if (candidate) {
    return {
      kind: 'switch',
      account: candidate.email,
      percentLeft: candidate.percentLeft,
      switching,
      switchAndContinue
    }
  }
  return hasOtherAccount ? null : { kind: 'add', agent, addAccount }
}

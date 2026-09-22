import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodexRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { useAppStore } from '../../store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  fetchProviderAccountsSnapshot,
  selectCodexProviderAccount
} from '@/runtime/runtime-provider-accounts-client'
import { translate } from '@/i18n/i18n'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel
} from '@/lib/codex-session-restart'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { getCodexAccountSyncKey, getCodexResetProjection } from './codex-switcher-projection'
import {
  getCodexStatusRuntimeKey,
  getStatusBarPreferredWslDistro,
  shouldIncludeSettingsWslRuntime,
  toCodexStatusRuntimeTarget,
  type CodexStatusRuntimeTarget,
  type CodexStatusSwitchGroup
} from './status-bar-runtime-targets'
import {
  buildCodexStatusSwitchGroups,
  getCodexStatusActiveId,
  normalizeCodexStatusRuntimeTarget,
  resolveCodexStatusAccountState
} from './status-bar-codex-accounts'
import { signInCodexAccount } from './codex-sign-in-action'

export function useCodexSwitcherController(codex: ProviderRateLimits) {
  const [open, setOpen] = useState(false)
  const [accountsExpanded, setAccountsExpanded] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [skipFutureResetConfirm, setSkipFutureResetConfirm] = useState(false)
  const [accounts, setAccounts] = useState<CodexRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null
  })
  const [isSwitching, setIsSwitching] = useState(false)
  const [isRedeemingReset, setIsRedeemingReset] = useState(false)
  const [reauthenticatingAccountId, setReauthenticatingAccountId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const accountsExpandedRef = useRef(accountsExpanded)
  // Why: Radix item-select is separate from the nested button click, so stopPropagation alone won't prevent the row switch.
  const suppressNextAccountSelectRef = useRef(false)
  const suppressNextAccountSelect = useCallback(() => {
    suppressNextAccountSelectRef.current = true
    window.setTimeout(() => {
      suppressNextAccountSelectRef.current = false
    }, 0)
  }, [])
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshCodexRateLimitsForTarget = useAppStore((s) => s.refreshCodexRateLimitsForTarget)
  const consumeCodexRateLimitResetCredit = useAppStore((s) => s.consumeCodexRateLimitResetCredit)
  const fetchInactiveCodexAccountUsage = useAppStore((s) => s.fetchInactiveCodexAccountUsage)
  const inactiveCodexAccounts = useAppStore((s) => s.rateLimits.inactiveCodexAccounts)
  const codexTarget = useAppStore((s) => s.rateLimits.codexTarget)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const hasActiveRuntimeEnvironment = Boolean(settings?.activeRuntimeEnvironmentId?.trim())
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const providerAccountHostLabel = hasActiveRuntimeEnvironment
    ? (runtimeEnvironments.find(
        (environment) => environment.id === settings?.activeRuntimeEnvironmentId?.trim()
      )?.name ??
      translate('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server'))
    : undefined
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows') || hasActiveRuntimeEnvironment,
    false,
    getWindowsTerminalCapabilityOwnerKey(settings?.activeRuntimeEnvironmentId),
    runtimeTarget
  )
  const codexAccountSyncKey = useAppStore((s) => getCodexAccountSyncKey(s.settings))
  const accountState = resolveCodexStatusAccountState(settings, accounts)

  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim() || null
  // Why: keyed on owner id, not settings identity, so routine settings mutations don't re-run the remote snapshot fetch.
  const loadAccounts = useCallback(async () => {
    const snapshot = await fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId })
    // Why: a failed Codex half is a substituted empty roster; keep prior state.
    if (snapshot.failedProviders?.includes('codex')) {
      console.error('Codex account list failed; keeping previous status bar state.')
      return
    }
    if (mountedRef.current) {
      setAccounts(snapshot.codex)
    }
  }, [activeRuntimeEnvironmentId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    accountsExpandedRef.current = accountsExpanded
  }, [accountsExpanded])

  useEffect(() => {
    // Why: the roster mounts this switcher on demand, while the sync key covers
    // account mutations without refetching again when its submenu opens.
    void loadAccounts().catch((error) => {
      console.error('Failed to load Codex accounts for status bar:', error)
    })
  }, [loadAccounts, codexAccountSyncKey])

  const handleSelectAccount = async (
    accountId: string | null,
    target: CodexStatusRuntimeTarget
  ): Promise<void> => {
    if (isSwitching || reauthenticatingAccountId !== null) {
      return
    }
    const previousActiveAccountId = getCodexStatusActiveId(accountState, target)
    setIsSwitching(true)
    try {
      const next = await selectCodexProviderAccount(settings, {
        accountId,
        runtime: target.runtime,
        wslDistro: target.wslDistro
      })
      recordFeatureInteraction('codex-account-switching')
      if (mountedRef.current) {
        setAccounts(next)
      }
      // Why: remote selections live on the server; local GlobalSettings are untouched, so refetching is pure churn.
      if (!hasActiveRuntimeEnvironment) {
        await fetchSettings()
      }
      const nextActiveAccountId = getCodexStatusActiveId(next, target)
      if (previousActiveAccountId !== nextActiveAccountId) {
        await markLiveCodexSessionsForRestart({
          previousAccountLabel: resolveCodexRestartPromptAccountLabel(
            accountState.accounts,
            previousActiveAccountId
          ),
          nextAccountLabel: resolveCodexRestartPromptAccountLabel(
            next.accounts,
            nextActiveAccountId
          ),
          // Why: two accounts can share an email, so the labels alone cannot
          // tell the store whether this switch lands back on the launch account.
          previousAccountId: previousActiveAccountId ?? null,
          nextAccountId: nextActiveAccountId ?? null,
          // Why: the mutation wrote this row's slot only, so panes on any other
          // lane still launch under the account they already had.
          target,
          // Why: clearing a distro-less WSL row nulls every distro slot at once.
          clearsEveryWslDistro: accountId === null
        })
        // Why: collapse to the summary row (not close) so the follow-up "restart open tabs" prompt appears in the same flow.
        if (mountedRef.current) {
          setAccountsExpanded(false)
        }
      }
    } catch (error) {
      console.error('Failed to switch Codex account from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsSwitching(false)
      }
    }
  }

  const handleSignInAccount = (
    accountId: string,
    target: CodexStatusRuntimeTarget
  ): Promise<void> =>
    signInCodexAccount(accountId, target, {
      accountState,
      accountsExpandedRef,
      fetchInactiveCodexAccountUsage,
      fetchSettings,
      isSwitching,
      mountedRef,
      reauthenticatingAccountId,
      recordFeatureInteraction,
      setAccounts,
      setAccountsExpanded,
      setReauthenticatingAccountId
    })

  const handleSelectRuntime = async (group: CodexStatusSwitchGroup): Promise<void> => {
    const currentKey = getCodexStatusRuntimeKey(
      normalizeCodexStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(codexTarget))
    )
    if (group.key === currentKey) {
      return
    }
    setAccountsExpanded(false)
    try {
      await refreshCodexRateLimitsForTarget(group.runtimeTarget)
    } catch (error) {
      console.error('Failed to switch Codex usage runtime:', error)
    }
  }

  const handleRedeemReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    setIsRedeemingReset(true)
    try {
      await consumeCodexRateLimitResetCredit()
    } catch (error) {
      console.error('Failed to redeem Codex rate-limit reset from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsRedeemingReset(false)
      }
    }
  }

  const handleResetMenuSelect = (): void => {
    if (settings?.skipCodexRateLimitResetConfirm) {
      void handleRedeemReset()
      return
    }
    setSkipFutureResetConfirm(false)
    setResetConfirmOpen(true)
  }

  const handleConfirmReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    if (skipFutureResetConfirm) {
      try {
        await updateSettings({ skipCodexRateLimitResetConfirm: true })
      } catch (error) {
        console.error('Failed to save Codex reset confirmation preference:', error)
      }
    }
    await handleRedeemReset()
    if (mountedRef.current) {
      setResetConfirmOpen(false)
      setSkipFutureResetConfirm(false)
    }
  }

  const handleOpenChange = useCallback((nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setAccountsExpanded(false)
    }
  }, [])

  const handleAccountsExpandedToggle = useCallback((): void => {
    const nextExpanded = !accountsExpanded
    setAccountsExpanded(nextExpanded)
    if (nextExpanded && !hasActiveRuntimeEnvironment) {
      // Why: fetch inactive-account usage only on switcher expansion; remote-owned accounts have no local cache to fill.
      void fetchInactiveCodexAccountUsage()
    }
  }, [accountsExpanded, fetchInactiveCodexAccountUsage, hasActiveRuntimeEnvironment])

  const selectedRuntimeKey = getCodexStatusRuntimeKey(
    normalizeCodexStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(codexTarget))
  )
  const fallbackWslDistro = getStatusBarPreferredWslDistro(
    settings,
    windowsTerminalCapabilities.wslDistros
  )
  const switchGroups = buildCodexStatusSwitchGroups(
    accountState,
    toCodexStatusRuntimeTarget(codexTarget),
    {
      fallbackWslDistro,
      includeFallbackWsl: !hasActiveRuntimeEnvironment && shouldIncludeSettingsWslRuntime(settings),
      hostLabel: providerAccountHostLabel
    }
  )
  const selectedGroup =
    switchGroups.find((group) => group.key === selectedRuntimeKey) ?? switchGroups[0]
  const activeTarget = selectedGroup?.targets.find((target) => target.active)
  const resetProjection = getCodexResetProjection(codex, hasActiveRuntimeEnvironment)

  return {
    accountsExpanded,
    activeTarget,
    handleAccountsExpandedToggle,
    handleConfirmReset,
    handleOpenChange,
    handleResetMenuSelect,
    handleSelectAccount,
    handleSelectRuntime,
    handleSignInAccount,
    hasActiveRuntimeEnvironment,
    inactiveCodexAccounts,
    isRedeemingReset,
    isSwitching,
    open,
    openSettingsPage,
    openSettingsTarget,
    reauthenticatingAccountId,
    resetConfirmOpen,
    ...resetProjection,
    selectedGroup,
    selectedRuntimeKey,
    setResetConfirmOpen,
    setSkipFutureResetConfirm,
    skipFutureResetConfirm,
    suppressNextAccountSelect,
    suppressNextAccountSelectRef,
    switchGroups
  }
}

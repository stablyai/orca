import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { useAppStore } from '../../store'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { useActiveAccountOwner } from '@/runtime/provider-accounts/ownership/use-active-account-owner'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  emptyCodexAccountsState,
  selectCodexProviderAccount
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { useTranslate } from '@/i18n/use-translate'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel
} from '@/lib/agent-session/accounts/codex/codex-session-restart'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
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
import { useProviderAccountList } from './use-provider-account-list'
import { getUsageOwnerHostScope, type OwnerUsageRateLimits } from './use-owner-usage-rate-limits'

export function useCodexSwitcherController(
  codex: ProviderRateLimits,
  ownerUsage?: OwnerUsageRateLimits
) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [skipFutureResetConfirm, setSkipFutureResetConfirm] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const [isRedeemingReset, setIsRedeemingReset] = useState(false)
  const [reauthenticatingAccountId, setReauthenticatingAccountId] = useState<string | null>(null)
  const menuOpenRef = useRef(open)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshCodexRateLimitsForTarget = useAppStore((s) => s.refreshCodexRateLimitsForTarget)
  const consumeCodexRateLimitResetCredit = useAppStore((s) => s.consumeCodexRateLimitResetCredit)
  const fetchInactiveCodexAccountUsage = useAppStore((s) => s.fetchInactiveCodexAccountUsage)
  const localRateLimits = useAppStore((s) => s.rateLimits)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const { target: activeOwnerTarget, wslHostDistro } = useActiveAccountOwner(
    defaultScopeHost(settings)
  )
  const usageOwner = ownerUsage?.remoteOwner
  const runtimeTarget = useMemo(
    () => (usageOwner === undefined ? activeOwnerTarget : getUsageOwnerHostScope(usageOwner)),
    [usageOwner, activeOwnerTarget]
  )
  const activeRuntimeEnvironmentId = runtimeTargetEnvironmentId(runtimeTarget)
  const hasActiveRuntimeEnvironment = activeRuntimeEnvironmentId !== null
  const usageState = ownerUsage?.rateLimits
  const inactiveCodexAccounts = hasActiveRuntimeEnvironment
    ? usageState?.codex?.usageMetadata?.unverifiableOwner
      ? []
      : (usageState?.inactiveCodexAccounts ?? [])
    : localRateLimits.inactiveCodexAccounts
  const codexTarget: CodexStatusRuntimeTarget = hasActiveRuntimeEnvironment
    ? (usageState?.codexTarget ?? { runtime: 'host', wslDistro: null })
    : localRateLimits.codexTarget
  const activeUsage = hasActiveRuntimeEnvironment ? (usageState?.codex ?? null) : codex
  const providerAccountHostLabel = hasActiveRuntimeEnvironment
    ? (runtimeEnvironments.find((environment) => environment.id === activeRuntimeEnvironmentId)
        ?.name ?? t('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server'))
    : undefined
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows') || hasActiveRuntimeEnvironment,
    false,
    getWindowsTerminalCapabilityOwnerKey(activeRuntimeEnvironmentId),
    runtimeTarget
  )
  const codexAccountSyncKey = useAppStore((s) => getCodexAccountSyncKey(s.settings))
  const { accounts, setAccounts, mountedRef } = useProviderAccountList(
    'codex',
    runtimeTarget,
    codexAccountSyncKey,
    emptyCodexAccountsState(),
    false,
    !hasActiveRuntimeEnvironment
  )
  const accountState = resolveCodexStatusAccountState(
    settings,
    hasActiveRuntimeEnvironment
      ? (ownerUsage?.accounts?.codex ?? emptyCodexAccountsState())
      : accounts,
    activeRuntimeEnvironmentId
  )

  useEffect(() => {
    menuOpenRef.current = open
  }, [open])

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
      const next = await selectCodexProviderAccount(runtimeTarget, {
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
          // Emails can coincide; IDs determine whether switching returns to the launch account.
          previousAccountId: previousActiveAccountId ?? null,
          nextAccountId: nextActiveAccountId ?? null,
          // Only this owner/runtime slot changed; other lanes keep their current launch accounts.
          owner: runtimeTarget,
          target,
          // Why: clearing a distro-less WSL row nulls every distro slot at once.
          clearsEveryWslDistro: accountId === null
        })
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
      menuOpenRef,
      fetchInactiveCodexAccountUsage,
      fetchSettings,
      isSwitching,
      mountedRef,
      reauthenticatingAccountId,
      recordFeatureInteraction,
      setAccounts,
      setReauthenticatingAccountId
    })

  const handleSelectRuntime = async (group: CodexStatusSwitchGroup): Promise<void> => {
    if (hasActiveRuntimeEnvironment) {
      return
    }
    const currentKey = getCodexStatusRuntimeKey(
      normalizeCodexStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(codexTarget))
    )
    if (group.key === currentKey) {
      return
    }
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

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen)
      if (nextOpen && !hasActiveRuntimeEnvironment) {
        void fetchInactiveCodexAccountUsage()
      }
    },
    [fetchInactiveCodexAccountUsage, hasActiveRuntimeEnvironment]
  )

  const selectedRuntimeKey = getCodexStatusRuntimeKey(
    normalizeCodexStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(codexTarget))
  )
  // A focused WSL host's accounts are this desktop's for its distro, so that group always shows.
  const fallbackWslDistro =
    wslHostDistro ??
    getStatusBarPreferredWslDistro(settings, windowsTerminalCapabilities.wslDistros)
  const switchGroups = buildCodexStatusSwitchGroups(
    accountState,
    toCodexStatusRuntimeTarget(codexTarget),
    {
      fallbackWslDistro,
      includeFallbackWsl:
        wslHostDistro !== null ||
        (!hasActiveRuntimeEnvironment && shouldIncludeSettingsWslRuntime(settings)),
      hostLabel: providerAccountHostLabel
    }
  )
  const selectedGroup =
    switchGroups.find((group) => group.key === selectedRuntimeKey) ?? switchGroups[0]
  const activeTarget = selectedGroup?.targets.find((target) => target.active)
  const resetProjection = getCodexResetProjection(codex, hasActiveRuntimeEnvironment, t)

  return {
    activeTarget,
    activeUsage,
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
    switchGroups
  }
}

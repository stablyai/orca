import { useCallback, useEffect, useRef, useState } from 'react'
import type { CodexRateLimitAccountsState } from '../../../../../shared/agent-accounts/managed-account-types'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { useAppStore } from '../../../store/index'
import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  emptyCodexAccountsState,
  selectCodexProviderAccount
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { useProviderAccountList } from './use-provider-account-list'
import { useTranslate } from '@/i18n/use-translate'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel
} from '@/lib/agent-session/accounts/codex/codex-session-restart'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import { getOwnerAccountRows } from './owner-account-rows'
import { getCodexAccountSyncKey } from './provider-account-sync-key'
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
import { useCodexResetAction } from './use-codex-reset-action'
import type { OwnerUsageRateLimits } from '../usage/use-owner-usage-rate-limits'

const EMPTY_CODEX_ACCOUNTS: CodexRateLimitAccountsState = emptyCodexAccountsState()

export function useCodexSwitcherController(
  codex: ProviderRateLimits,
  ownerUsage: OwnerUsageRateLimits,
  owner: AccountOwner
) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const [reauthenticatingAccountId, setReauthenticatingAccountId] = useState<string | null>(null)
  // Why: pending-action flags outlive an owner change; the list hook's guard is per owner.
  const mountedRef = useRef(true)
  const menuOpenRef = useRef(open)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshCodexRateLimitsForTarget = useAppStore((s) => s.refreshCodexRateLimitsForTarget)
  const fetchInactiveCodexAccountUsage = useAppStore((s) => s.fetchInactiveCodexAccountUsage)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const { target: runtimeTarget, wslHostDistro } = owner
  const activeRuntimeEnvironmentId = runtimeTargetEnvironmentId(runtimeTarget)
  const hasActiveRuntimeEnvironment = activeRuntimeEnvironmentId !== null
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
  const {
    accounts,
    setAccounts,
    loadAccounts,
    mountedRef: ownerMountedRef
  } = useProviderAccountList(
    'codex',
    runtimeTarget,
    codexAccountSyncKey,
    EMPTY_CODEX_ACCOUNTS,
    !hasActiveRuntimeEnvironment
  )
  const {
    roster,
    rosterKnown,
    inactiveAccounts: inactiveCodexAccounts,
    usageTarget
  } = getOwnerAccountRows('codex', ownerUsage, accounts, EMPTY_CODEX_ACCOUNTS)
  const codexTarget = wslHostDistro
    ? { runtime: 'wsl' as const, wslDistro: wslHostDistro }
    : usageTarget
  const accountState = resolveCodexStatusAccountState(settings, roster, activeRuntimeEnvironmentId)
  const requestedTarget = toCodexStatusRuntimeTarget(codexTarget)
  const selectedRuntimeKey = getCodexStatusRuntimeKey(
    normalizeCodexStatusRuntimeTarget(accountState, requestedTarget)
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

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
      setAccounts(next)
      // Why: remote selections live on the server; local GlobalSettings are untouched, so refetching is pure churn.
      if (!hasActiveRuntimeEnvironment) {
        await fetchSettings()
      }
      // Why: a distro selection changes its own reading, which no stream pushes to the footer.
      if (wslHostDistro) {
        void ownerUsage.refreshRemote?.({ invalidate: true })
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
      ownerMountedRef,
      reauthenticatingAccountId,
      recordFeatureInteraction,
      setAccounts,
      setReauthenticatingAccountId
    })

  const handleSelectRuntime = async (group: CodexStatusSwitchGroup): Promise<void> => {
    if (hasActiveRuntimeEnvironment || wslHostDistro !== null || group.key === selectedRuntimeKey) {
      return
    }
    try {
      await refreshCodexRateLimitsForTarget(group.runtimeTarget)
    } catch (error) {
      console.error('Failed to switch Codex usage runtime:', error)
    }
  }

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen)
      if (nextOpen) {
        // A remote host's renames and removals change no local settings; reread on open.
        void loadAccounts().catch((error: unknown) =>
          console.error('Failed to load Codex accounts for status bar:', error)
        )
      }
      if (nextOpen && !hasActiveRuntimeEnvironment) {
        void fetchInactiveCodexAccountUsage()
      }
    },
    [fetchInactiveCodexAccountUsage, hasActiveRuntimeEnvironment, loadAccounts]
  )

  // A focused WSL host's accounts are this desktop's for its distro, so that group always shows.
  const fallbackWslDistro =
    wslHostDistro ??
    getStatusBarPreferredWslDistro(settings, windowsTerminalCapabilities.wslDistros)
  const switchGroups = buildCodexStatusSwitchGroups(accountState, requestedTarget, {
    fallbackWslDistro,
    includeFallbackWsl:
      wslHostDistro !== null ||
      (!hasActiveRuntimeEnvironment && shouldIncludeSettingsWslRuntime(settings)),
    hostLabel: providerAccountHostLabel
  })
  const authFailureAccount = codex.usageMetadata?.authFailureAccount
  // A default WSL reading can identify a concrete recovery account without pinning the runtime.
  const accountRuntimeKey =
    requestedTarget.runtime === 'wsl' &&
    !requestedTarget.wslDistro &&
    authFailureAccount?.runtime === 'wsl' &&
    authFailureAccount.wslDistro
      ? getCodexStatusRuntimeKey(authFailureAccount)
      : selectedRuntimeKey
  const selectedGroup =
    switchGroups.find((group) => group.key === accountRuntimeKey) ?? switchGroups[0]
  const activeTarget = selectedGroup?.targets.find((target) => target.active)
  const reset = useCodexResetAction(
    codex,
    activeRuntimeEnvironmentId,
    hasActiveRuntimeEnvironment ? ownerUsage.accounts : null,
    open,
    wslHostDistro === null && codexTarget.runtime !== 'wsl'
  )

  return {
    activeTarget,
    handleOpenChange,
    handleSelectAccount,
    handleSelectRuntime,
    handleSignInAccount,
    hasActiveRuntimeEnvironment,
    inactiveCodexAccounts,
    isSwitching,
    open,
    openSettingsPage,
    openSettingsTarget,
    providerAccountHostLabel,
    reauthenticatingAccountId,
    rosterKnown,
    ...reset,
    selectedGroup,
    selectedRuntimeKey,
    switchGroups
  }
}

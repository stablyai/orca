import { useClaudeSwitcherState } from './use-claude-switcher-state'
import type { ClaudeSwitcherMenuProps } from './ClaudeSwitcherMenu'
import { useProviderAccountList } from './use-provider-account-list'
import { providerChatAccountControl } from './ProviderAccountChatButton'
import React, { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../../../store/index'
import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  selectClaudeProviderAccount,
  emptyClaudeAccountsState
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { toast } from 'sonner'
import { getClaudeAccountErrorDescription } from '../../../lib/provider-accounts/provider-account-action-errors'
import { useTranslate } from '@/i18n/use-translate'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import {
  getCodexStatusRuntimeKey,
  getStatusBarPreferredWslDistro,
  shouldIncludeSettingsWslRuntime,
  toCodexStatusRuntimeTarget,
  type ClaudeStatusSwitchGroup,
  type CodexStatusRuntimeTarget
} from './status-bar-runtime-targets'
import {
  buildClaudeStatusSwitchGroups,
  signedInClaudeAccountCount,
  getClaudeStatusActiveId,
  normalizeClaudeStatusRuntimeTarget,
  resolveClaudeStatusAccountState
} from './status-bar-claude-accounts'
import { handleRunningClaudeSessionsAfterSwitch } from '@/lib/provider-accounts/claude-account-switch-sessions'
import { AccountRuntimeToggle } from '../composition/StatusBarAccountControls'
import { InlineUsageSignInAction, InlineUsageSkeleton } from '../usage/InlineProviderUsage'
import {
  AccountUsageGauge,
  AccountUsageNotChecked,
  isClaudeAccountNotChecked
} from './AccountUsageGauge'
import { AccountSwitchSection, AccountSwitchSignedOutHeading } from './AccountSwitchList'
import { AccountSwitchRowItem } from './AccountSwitchRowItem'
import { ProviderDetailsMenu } from '../usage/ProviderDetailsMenu'
import { signInToClaudeAccount } from '@/lib/provider-accounts/claude-account-sign-in'

// Retain account switch/reset drill-in even though the footer now opens UsageRosterPanel.
export function ClaudeSwitcherForOwner({
  claude,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent,
  chatAction,
  owner
}: ClaudeSwitcherMenuProps & { owner: AccountOwner }): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const [signingInId, setSigningInId] = useState<string | null>(null)
  const signingInRef = useRef(false)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshClaudeRateLimitsForTarget = useAppStore((s) => s.refreshClaudeRateLimitsForTarget)
  const fetchInactiveClaudeAccountUsage = useAppStore((s) => s.fetchInactiveClaudeAccountUsage)
  const runtimeTarget = chatAction?.target ?? owner.target
  const wslHostDistro = chatAction ? null : owner.wslHostDistro
  const activeRuntimeEnvironmentId = runtimeTargetEnvironmentId(runtimeTarget)
  const hasActiveRuntimeEnvironment = activeRuntimeEnvironmentId !== null
  const {
    inactiveClaudeAccounts,
    claudeTarget,
    settings,
    ownHostName,
    accountSettings,
    claudeAccountSyncKey
  } = useClaudeSwitcherState(chatAction, activeRuntimeEnvironmentId)
  const providerAccountHostLabel = hasActiveRuntimeEnvironment
    ? (ownHostName ?? t('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server'))
    : undefined
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows') || hasActiveRuntimeEnvironment,
    false,
    getWindowsTerminalCapabilityOwnerKey(activeRuntimeEnvironmentId),
    runtimeTarget
  )
  const { accounts, setAccounts, accountsLoaded, loadAccounts, mountedRef } =
    useProviderAccountList(
      'claude',
      runtimeTarget,
      claudeAccountSyncKey,
      emptyClaudeAccountsState(),
      !!chatAction
    )
  const accountState = resolveClaudeStatusAccountState(
    accountSettings,
    accounts,
    activeRuntimeEnvironmentId
  )

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen)
      if (!nextOpen) {
        return
      }
      if (!hasActiveRuntimeEnvironment) {
        void fetchInactiveClaudeAccountUsage()
      }
      // Why reload: the login each account folder holds changes without a settings change.
      void loadAccounts().catch((error) => {
        console.error('Failed to load Claude accounts for status bar:', error)
      })
    },
    [fetchInactiveClaudeAccountUsage, hasActiveRuntimeEnvironment, loadAccounts]
  )

  const handleSelectAccount = async (
    accountId: string | null,
    target: CodexStatusRuntimeTarget
  ): Promise<void> => {
    if (isSwitching) {
      return
    }
    const previousActiveAccountId = getClaudeStatusActiveId(accountState, target)
    setIsSwitching(true)
    try {
      if (chatAction && !(await chatAction.canSwitch())) {
        toast.error(
          t(
            'components.native-chat.usageLimitActions.accountUnavailable',
            'This chat cannot move to another account. Hand it off to another agent instead.'
          )
        )
        return
      }
      const next = await selectClaudeProviderAccount(runtimeTarget, {
        accountId,
        runtime: target.runtime,
        wslDistro: target.wslDistro
      })
      recordFeatureInteraction('claude-account-switching')
      if (mountedRef.current) {
        setAccounts(next)
      }
      // Why: remote selections live on the server; local GlobalSettings are untouched, so refetching is pure churn.
      if (!hasActiveRuntimeEnvironment) {
        await fetchSettings()
      }
      const nextActiveAccountId = getClaudeStatusActiveId(next, target)
      if (!chatAction && previousActiveAccountId !== nextActiveAccountId) {
        void handleRunningClaudeSessionsAfterSwitch({
          owner: runtimeTarget,
          target,
          before: { state: accountState, accountId: previousActiveAccountId },
          after: { state: next, accountId: nextActiveAccountId }
        })
      }
    } catch (error) {
      console.error('Failed to switch Claude account from status bar:', error)
      toast.error(
        t('auto.components.settings.AccountsPane.2743cdc0af', 'Claude account update failed.'),
        { description: getClaudeAccountErrorDescription(error) }
      )
    } finally {
      if (mountedRef.current) {
        setIsSwitching(false)
      }
    }
  }

  const handleSignIn = async (accountId: string): Promise<void> => {
    // Why a ref: the row and its button both sign in, and state lags a double press.
    if (signingInRef.current) {
      return
    }
    signingInRef.current = true
    setSigningInId(accountId)
    try {
      if (await signInToClaudeAccount(accountId)) {
        await loadAccounts()
      }
    } finally {
      signingInRef.current = false
      if (mountedRef.current) {
        setSigningInId(null)
      }
    }
  }

  const handleSelectRuntime = async (group: ClaudeStatusSwitchGroup): Promise<void> => {
    const currentKey = getCodexStatusRuntimeKey(
      normalizeClaudeStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(claudeTarget))
    )
    if (group.key === currentKey) {
      return
    }
    try {
      await refreshClaudeRateLimitsForTarget(group.runtimeTarget)
    } catch (error) {
      console.error('Failed to switch Claude usage runtime:', error)
    }
  }

  const selectedRuntimeKey = getCodexStatusRuntimeKey(
    normalizeClaudeStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(claudeTarget))
  )
  // A focused WSL host's accounts are this desktop's for its distro, so that group always shows.
  const fallbackWslDistro =
    wslHostDistro ??
    getStatusBarPreferredWslDistro(settings, windowsTerminalCapabilities.wslDistros)
  const switchGroups = buildClaudeStatusSwitchGroups(
    accountState,
    toCodexStatusRuntimeTarget(claudeTarget),
    {
      fallbackWslDistro,
      includeFallbackWsl:
        wslHostDistro !== null ||
        (!hasActiveRuntimeEnvironment && shouldIncludeSettingsWslRuntime(settings)),
      hostLabel: providerAccountHostLabel
    }
  )
  const selectedGroup = chatAction
    ? switchGroups.find((group) => group.runtimeTarget.runtime === 'host')
    : (switchGroups.find((group) => group.key === selectedRuntimeKey) ?? switchGroups[0])

  const accountControl = providerChatAccountControl(
    'claude',
    chatAction,
    accountsLoaded,
    signedInClaudeAccountCount(accounts),
    isSwitching
  )
  if (accountControl?.add) {
    return runtimeTarget.kind === 'local' ? accountControl.button : null
  }

  const rows = (selectedGroup?.targets ?? []).map((target) => ({
    target,
    inactiveUsage: target.id ? inactiveClaudeAccounts.find((a) => a.accountId === target.id) : null,
    // Why local only: the hidden sign-in runs on this device, not a remote server.
    signInId: target.needsSignIn && !hasActiveRuntimeEnvironment ? target.id : null
  }))
  const signedOutRows = rows.filter((row) => row.signInId)
  // Why not the hook: this runs after an early return, so it must stay a plain call.
  const notCheckedDescription = t(
    'auto.components.status.bar.tooltip.claude.waiting.label',
    'Updates when Claude runs'
  )
  // Why: rows follow this desktop's Claude target, so a remote owner's usage could land on the wrong row.
  const liveActiveUsage = !hasActiveRuntimeEnvironment && !chatAction ? claude : null
  const rowUsage = (
    target: (typeof rows)[number]['target'],
    inactiveUsage: (typeof rows)[number]['inactiveUsage']
  ): React.ReactNode => {
    if (target.active && liveActiveUsage) {
      return (
        <AccountUsageGauge
          limits={liveActiveUsage}
          isFetching={liveActiveUsage.status === 'fetching'}
        />
      )
    }
    if (inactiveUsage?.isFetching && !inactiveUsage.rateLimits) {
      return <InlineUsageSkeleton />
    }
    if (inactiveUsage?.rateLimits) {
      return (
        <AccountUsageGauge
          limits={inactiveUsage.rateLimits}
          isFetching={inactiveUsage.isFetching}
        />
      )
    }
    // Why local only: a remote owner never reads inactive accounts here, so "not checked" would be wrong.
    return target.id && !target.active && !hasActiveRuntimeEnvironment ? (
      <AccountUsageNotChecked />
    ) : null
  }
  const renderRow = ({
    target,
    inactiveUsage,
    signInId
  }: (typeof rows)[number]): React.JSX.Element => (
    <AccountSwitchRowItem
      label={target.label}
      detail={target.hint}
      active={target.active}
      key={`${selectedGroup?.key}:${target.id ?? 'system'}`}
      aria-description={
        !signInId &&
        !target.active &&
        target.id &&
        !hasActiveRuntimeEnvironment &&
        !inactiveUsage?.isFetching &&
        isClaudeAccountNotChecked(inactiveUsage?.rateLimits)
          ? notCheckedDescription
          : undefined
      }
      disabled={
        isSwitching ||
        signingInId !== null ||
        (signInId === null && (target.active || target.disabled))
      }
      onSelect={(event) => {
        event.preventDefault()
        if (signInId) {
          void handleSignIn(signInId)
        } else if (!target.active) {
          void handleSelectAccount(target.id, target.runtimeTarget)
        }
      }}
      action={
        signInId ? (
          <InlineUsageSignInAction
            accountLabel={target.label}
            isSigningIn={signingInId === signInId}
            disabled={isSwitching || signingInId !== null}
            onSignIn={() => void handleSignIn(signInId)}
          />
        ) : undefined
      }
    >
      {signInId ? null : rowUsage(target, inactiveUsage)}
    </AccountSwitchRowItem>
  )

  return (
    <ProviderDetailsMenu
      provider={claude}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      trigger={accountControl?.button}
      ariaLabel={t(
        'auto.components.status.bar.StatusBar.3dd7ddfae1',
        'Open Claude details and account switcher'
      )}
      variant="account"
      accountLabel={
        !hasActiveRuntimeEnvironment
          ? (selectedGroup?.targets.find((target) => target.active)?.label ??
            t('auto.components.status.bar.StatusBar.c676918adc', 'System default'))
          : undefined
      }
      topContent={
        chatAction ? undefined : (
          <AccountRuntimeToggle
            groups={switchGroups}
            value={selectedGroup?.key ?? selectedRuntimeKey}
            onChange={(group) => void handleSelectRuntime(group)}
            ariaLabel={t('auto.components.status.bar.StatusBar.11e2354daf', 'Claude usage runtime')}
          />
        )
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <AccountSwitchSection
        heading={t('auto.components.status.bar.AccountSwitchList.accounts', 'Accounts')}
        targets={selectedGroup?.targets ?? []}
        panelShowsActiveAccount={!hasActiveRuntimeEnvironment}
        onOpenSettings={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-claude',
            ...(chatAction ? { hostScope: chatAction.target, intent: 'native-accounts' } : {})
          })
          openSettingsPage()
        }}
      >
        {rows.filter((row) => !row.signInId).map(renderRow)}
        {signedOutRows.length > 0 ? (
          <>
            <AccountSwitchSignedOutHeading />
            {signedOutRows.map(renderRow)}
          </>
        ) : null}
      </AccountSwitchSection>
    </ProviderDetailsMenu>
  )
}

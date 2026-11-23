import { useClaudeSwitcherState } from './use-claude-switcher-state'
import type { ClaudeSwitcherMenuProps } from './ClaudeSwitcherMenu'
import type { ChatAccountAction } from './ProviderAccountChatButton'
import type { OwnerUsageRateLimits } from '../usage/use-owner-usage-rate-limits'
import { useProviderAccountList } from './use-provider-account-list'
import { providerChatAccountControl } from './ProviderAccountChatButton'
import React, { useCallback, useState } from 'react'
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
  claudeRowUsageId,
  getStatusBarPreferredWslDistro,
  shouldIncludeSettingsWslRuntime,
  toCodexStatusRuntimeTarget,
  type ClaudeStatusSwitchGroup,
  type CodexStatusRuntimeTarget
} from './status-bar-runtime-targets'
import {
  buildClaudeStatusSwitchGroups,
  getClaudeStatusRuntimeKey,
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
import { claudeInactiveUsageId } from '../../../../../shared/agent-accounts/claude/claude-system-default-usage'
import { getOwnerAccountRows } from './owner-account-rows'
import {
  claudeAccountCardSignIn,
  useClaudeAccountSignIn,
  useOpenClaudeAccountSettings
} from './claude-account-card-sign-in'

const EMPTY_CLAUDE_ACCOUNTS = emptyClaudeAccountsState()

export function ClaudeSwitcherForOwner({
  claude,
  iconOnly,
  asSubmenu = false,
  triggerContent,
  chatAction,
  ownerUsage,
  owner
}: Omit<ClaudeSwitcherMenuProps, 'chatAction' | 'ownerUsage'> & {
  chatAction?: ChatAccountAction
  /** Rows, roster and readings all come from this owner's observation. */
  ownerUsage: OwnerUsageRateLimits
  owner: AccountOwner
}): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshClaudeRateLimitsForTarget = useAppStore((s) => s.refreshClaudeRateLimitsForTarget)
  const fetchInactiveClaudeAccountUsage = useAppStore((s) => s.fetchInactiveClaudeAccountUsage)
  const runtimeTarget = chatAction?.target ?? owner.target
  const openAccountSettings = useOpenClaudeAccountSettings(runtimeTarget, Boolean(chatAction))
  const wslHostDistro = chatAction ? null : owner.wslHostDistro
  const activeRuntimeEnvironmentId = runtimeTargetEnvironmentId(runtimeTarget)
  const hasActiveRuntimeEnvironment = activeRuntimeEnvironmentId !== null
  const { settings, ownHostName, accountSettings, claudeAccountSyncKey } = useClaudeSwitcherState(
    chatAction,
    activeRuntimeEnvironmentId
  )
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
      EMPTY_CLAUDE_ACCOUNTS,
      !ownerUsage.remoteOwner
    )
  const { signingInId, handleSignIn } = useClaudeAccountSignIn(loadAccounts, mountedRef)
  const {
    roster,
    rosterKnown,
    inactiveAccounts: inactiveClaudeAccounts,
    usageTarget
  } = getOwnerAccountRows('claude', ownerUsage, accounts, EMPTY_CLAUDE_ACCOUNTS)
  const claudeTarget = wslHostDistro
    ? { runtime: 'wsl' as const, wslDistro: wslHostDistro }
    : usageTarget
  // Why: a chat's local list loads on its own; a remote roster rides the owner's stream.
  const rosterLoaded = ownerUsage.remoteOwner ? rosterKnown : accountsLoaded
  const accountState = resolveClaudeStatusAccountState(
    accountSettings,
    roster,
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
      const { runningSessions, ...next } = await selectClaudeProviderAccount(runtimeTarget, {
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
      if (runningSessions || (!chatAction && previousActiveAccountId !== nextActiveAccountId)) {
        void handleRunningClaudeSessionsAfterSwitch({
          owner: runtimeTarget,
          target,
          before: { state: accountState, accountId: previousActiveAccountId ?? null },
          after: { state: next, accountId: nextActiveAccountId ?? null },
          ...(runningSessions ? { hostMove: runningSessions } : {})
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

  const handleSelectRuntime = async (group: ClaudeStatusSwitchGroup): Promise<void> => {
    const currentKey = getClaudeStatusRuntimeKey(
      normalizeClaudeStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(claudeTarget))
    )
    if (hasActiveRuntimeEnvironment || wslHostDistro !== null || group.key === currentKey) {
      return
    }
    try {
      await refreshClaudeRateLimitsForTarget(group.runtimeTarget)
    } catch (error) {
      console.error('Failed to switch Claude usage runtime:', error)
    }
  }

  const selectedRuntimeKey = getClaudeStatusRuntimeKey(
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
  const activeTarget = selectedGroup?.targets.find((target) => target.active)
  const panelShowsActiveAccount = !chatAction || !hasActiveRuntimeEnvironment

  const accountControl = providerChatAccountControl(
    'claude',
    chatAction,
    rosterLoaded,
    signedInClaudeAccountCount(roster),
    isSwitching
  )
  if (accountControl?.add) {
    return runtimeTarget.kind === 'local' ? accountControl.button : null
  }

  const rows = (selectedGroup?.targets ?? []).map((target) => ({
    // Why: accounts.selectClaude takes no runtime, so clearing a remote WSL slot would clear the host's.
    target:
      hasActiveRuntimeEnvironment && target.id === null && target.runtimeTarget.runtime === 'wsl'
        ? { ...target, disabled: true }
        : target,
    inactiveUsage: inactiveClaudeAccounts.find((a) => a.accountId === claudeRowUsageId(target)),
    // Why local only: the hidden sign-in runs on this device, not a remote server.
    signInId: target.needsSignIn && !hasActiveRuntimeEnvironment ? target.id : null
  }))
  const signedOutRows = rows.filter((row) => row.target.needsSignIn && !row.target.usableAccountId)
  const signedOutRowSet = new Set(signedOutRows)
  // Why not the hook: this runs after an early return, so it must stay a plain call.
  const notCheckedDescription = t(
    'auto.components.status.bar.tooltip.claude.waiting.label',
    'Updates when Claude runs'
  )
  // Why: `claude` and the rows come from the same owner snapshot, so its active row is the reading's account.
  const liveActiveUsage = chatAction ? null : claude
  const rowUsage = (
    target: (typeof rows)[number]['target'],
    inactiveUsage: (typeof rows)[number]['inactiveUsage']
  ): React.ReactNode => {
    if (target.active && !target.needsSignIn && liveActiveUsage) {
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
    // Why local only: an older host publishes no per-account readings, so "not checked" could be false.
    return claudeInactiveUsageId(target) && !hasActiveRuntimeEnvironment ? (
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
      detail={target.detail ?? target.hint}
      active={target.active}
      key={`${selectedGroup?.key}:${target.id ?? 'system'}`}
      aria-description={
        !signInId &&
        claudeInactiveUsageId(target) &&
        !hasActiveRuntimeEnvironment &&
        !inactiveUsage?.isFetching &&
        isClaudeAccountNotChecked(inactiveUsage?.rateLimits)
          ? notCheckedDescription
          : undefined
      }
      disabled={
        isSwitching ||
        signingInId !== null ||
        target.active ||
        (signInId === null && target.disabled)
      }
      onSelect={(event) => {
        event.preventDefault()
        if (target.active) {
          return
        }
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
      {target.needsSignIn && !target.usableAccountId ? null : rowUsage(target, inactiveUsage)}
    </AccountSwitchRowItem>
  )

  return (
    <ProviderDetailsMenu
      provider={claude}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      trigger={accountControl?.button}
      ariaLabel={t(
        'auto.components.status.bar.StatusBar.3dd7ddfae1',
        'Open Claude details and account switcher'
      )}
      variant="account"
      accountStatus={
        activeTarget?.needsSignIn ? (
          <div role="status" className="font-medium">
            {t('auto.components.status.bar.StatusBar.signedOutAccounts', 'Signed out')}
          </div>
        ) : undefined
      }
      accountLabel={panelShowsActiveAccount && rosterKnown ? activeTarget?.label : undefined}
      accountStatusAction={claudeAccountCardSignIn({
        claude,
        target: panelShowsActiveAccount ? activeTarget : undefined,
        signingInId,
        disabled: isSwitching,
        onSignIn: (accountId) => {
          // Why: the hidden sign-in runs on this device; a server's login runs from its Settings section.
          if (hasActiveRuntimeEnvironment) {
            setOpen(false)
            openAccountSettings()
          } else {
            void handleSignIn(accountId)
          }
        }
      })}
      topContent={
        // Why: runtime selection refreshes this desktop's own usage, so a remote owner has none here.
        chatAction || hasActiveRuntimeEnvironment || wslHostDistro !== null ? undefined : (
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
      {/* Why: until the host lists its accounts, the empty roster's only row would claim "System default". */}
      {rosterKnown ? (
        <AccountSwitchSection
          heading={t('auto.components.status.bar.AccountSwitchList.accounts', 'Accounts')}
          targets={selectedGroup?.targets ?? []}
          panelShowsActiveAccount={panelShowsActiveAccount}
          onOpenSettings={openAccountSettings}
        >
          {rows.filter((row) => !signedOutRowSet.has(row)).map(renderRow)}
          {signedOutRows.length > 0 ? (
            <>
              <AccountSwitchSignedOutHeading />
              {signedOutRows.map(renderRow)}
            </>
          ) : null}
        </AccountSwitchSection>
      ) : null}
    </ProviderDetailsMenu>
  )
}

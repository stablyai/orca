import { useClaudeSwitcherState } from './use-claude-switcher-state'
import type { ClaudeSwitcherMenuProps } from './ClaudeSwitcherMenu'
import { useProviderAccountList } from './use-provider-account-list'
import { providerChatAccountControl } from './ProviderAccountChatButton'
import React, { useCallback, useRef, useState } from 'react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { AccountOwner } from '@/lib/wsl-host-account-owner'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import {
  selectClaudeProviderAccount,
  emptyClaudeAccountsState
} from '@/runtime/runtime-provider-accounts-client'
import { toast } from 'sonner'
import { getClaudeAccountErrorDescription } from '../settings/accounts-pane-action-errors'
import { translate } from '@/i18n/i18n'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
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
import { handleRunningClaudeSessionsAfterSwitch } from '@/lib/claude-account-switch-sessions'
import { AccountRuntimeToggle } from './StatusBarAccountControls'
import {
  InlineUsageBars,
  InlineUsageSignInAction,
  InlineUsageSkeleton
} from './InlineProviderUsage'
import { AccountSwitchList } from './AccountSwitchList'
import { AccountSwitchRowItem } from './AccountSwitchRowItem'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { signInToClaudeAccount } from '@/lib/claude-account-sign-in'

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
    ? (ownHostName ??
      translate('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server'))
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
          translate(
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
        translate(
          'auto.components.settings.AccountsPane.2743cdc0af',
          'Claude account update failed.'
        ),
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

  return (
    <ProviderDetailsMenu
      provider={claude}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      trigger={accountControl?.button}
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.3dd7ddfae1',
        'Open Claude details and account switcher'
      )}
      variant="account"
      accountLabel={
        !hasActiveRuntimeEnvironment
          ? (selectedGroup?.targets.find((target) => target.active)?.label ??
            translate('auto.components.status.bar.StatusBar.c676918adc', 'System default'))
          : undefined
      }
      topContent={
        chatAction ? undefined : (
          <AccountRuntimeToggle
            groups={switchGroups}
            value={selectedGroup?.key ?? selectedRuntimeKey}
            onChange={(group) => void handleSelectRuntime(group)}
            ariaLabel={translate(
              'auto.components.status.bar.StatusBar.11e2354daf',
              'Claude usage runtime'
            )}
          />
        )
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <AccountSwitchList
        heading={translate('auto.components.status.bar.StatusBar.d450654fa2', 'Claude Account')}
      >
        {selectedGroup?.targets.length === 0 ? (
          <div className="px-2 py-1.5 text-2xs text-muted-foreground">
            {translate('auto.components.status.bar.StatusBar.c98ea88392', 'No other accounts')}
          </div>
        ) : null}
        {selectedGroup?.targets.map((target) => {
          const inactiveUsage = target.id
            ? inactiveClaudeAccounts.find((a) => a.accountId === target.id)
            : null
          // Why local only: the hidden sign-in runs on this device, not a remote server.
          const signInId = target.needsSignIn && !hasActiveRuntimeEnvironment ? target.id : null

          return (
            <AccountSwitchRowItem
              label={target.label}
              active={target.active}
              key={`${selectedGroup.key}:${target.id ?? 'system'}`}
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
                    isFetching={false}
                    isSigningIn={signingInId === signInId}
                    disabled={isSwitching || signingInId !== null}
                    reason={target.hint ?? undefined}
                    onSignIn={() => void handleSignIn(signInId)}
                  />
                ) : undefined
              }
            >
              {!signInId ? (
                <div className="flex w-full flex-col gap-0.5">
                  {target.hint ? (
                    <span className="text-3xs leading-4 text-muted-foreground">{target.hint}</span>
                  ) : null}
                  {inactiveUsage?.isFetching && !inactiveUsage.rateLimits ? (
                    <InlineUsageSkeleton />
                  ) : inactiveUsage?.rateLimits ? (
                    <InlineUsageBars
                      limits={inactiveUsage.rateLimits}
                      isFetching={inactiveUsage.isFetching}
                    />
                  ) : null}
                </div>
              ) : null}
            </AccountSwitchRowItem>
          )
        })}
      </AccountSwitchList>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-claude',
            ...(chatAction ? { hostScope: chatAction.target, intent: 'native-accounts' } : {})
          })
          openSettingsPage()
        }}
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}

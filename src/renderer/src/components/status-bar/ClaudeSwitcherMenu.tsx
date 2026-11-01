import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { defaultScopeHost } from '@/lib/default-creation-host'
import { useActiveAccountOwner } from '@/runtime/use-worktree-runtime-target'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import {
  fetchProviderAccountsSnapshot,
  selectClaudeProviderAccount
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
  getClaudeStatusActiveId,
  normalizeClaudeStatusRuntimeTarget,
  resolveClaudeStatusAccountState
} from './status-bar-claude-accounts'
import { handleRunningClaudeSessionsAfterSwitch } from '@/lib/claude-account-switch-sessions'
import { AccountRuntimeToggle } from './StatusBarAccountControls'
import { AccountIdentityHeader } from './AccountIdentityHeader'
import {
  AccountSwitchList,
  getAccountSwitchStatusLabel,
  type AccountSwitchListRow
} from './AccountSwitchList'
import { getAccountSwitchUsage, isUnavailableInactiveUsage } from './account-switch-row-model'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { getClaudeAccountSyncKey } from './provider-account-sync-key'
import { signInToClaudeAccount } from '@/lib/claude-account-sign-in'

// Retain account switch/reset drill-in even though the footer now opens UsageRosterPanel.
export function ClaudeSwitcherMenu({
  claude,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  claude: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [accounts, setAccounts] = useState<ClaudeRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
  const [isSwitching, setIsSwitching] = useState(false)
  const [signingInId, setSigningInId] = useState<string | null>(null)
  const signingInRef = useRef(false)
  const mountedRef = useRef(true)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshClaudeRateLimitsForTarget = useAppStore((s) => s.refreshClaudeRateLimitsForTarget)
  const fetchInactiveClaudeAccountUsage = useAppStore((s) => s.fetchInactiveClaudeAccountUsage)
  const inactiveClaudeAccounts = useAppStore((s) => s.rateLimits.inactiveClaudeAccounts)
  const claudeTarget = useAppStore((s) => s.rateLimits.claudeTarget)
  const settings = useAppStore((s) => s.settings)
  const usagePercentageDisplay = normalizeUsagePercentageDisplay(
    useAppStore((s) => s.usagePercentageDisplay)
  )
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const { target: runtimeTarget, wslHostDistro } = useActiveAccountOwner(defaultScopeHost(settings))
  const activeRuntimeEnvironmentId = runtimeTargetEnvironmentId(runtimeTarget)
  const hasActiveRuntimeEnvironment = activeRuntimeEnvironmentId !== null
  const providerAccountHostLabel = hasActiveRuntimeEnvironment
    ? (runtimeEnvironments.find((environment) => environment.id === activeRuntimeEnvironmentId)
        ?.name ??
      translate('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server'))
    : undefined
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows') || hasActiveRuntimeEnvironment,
    false,
    getWindowsTerminalCapabilityOwnerKey(activeRuntimeEnvironmentId),
    runtimeTarget
  )
  const claudeAccountSyncKey = useAppStore((s) => getClaudeAccountSyncKey(s.settings))
  const accountState = resolveClaudeStatusAccountState(
    settings,
    accounts,
    activeRuntimeEnvironmentId
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Why: keyed on owner id, not settings identity, so routine settings mutations don't re-run the remote snapshot fetch.
  const loadAccounts = useCallback(async () => {
    const snapshot = await fetchProviderAccountsSnapshot(runtimeTarget)
    // Why: a failed Claude half is a substituted empty roster; keep prior state.
    if (snapshot.failedProviders?.includes('claude')) {
      console.error('Claude account list failed; keeping previous status bar state.')
      return
    }
    if (mountedRef.current) {
      setAccounts(snapshot.claude)
    }
  }, [runtimeTarget])

  useEffect(() => {
    void loadAccounts().catch((error) => {
      console.error('Failed to load Claude accounts for status bar:', error)
    })
  }, [loadAccounts, claudeAccountSyncKey])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen)
      if (!nextOpen) {
        return
      }
      // Why: the account list shows on open; main debounces these fetches. Remote-owned accounts have no local cache to fill.
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
      if (previousActiveAccountId !== nextActiveAccountId) {
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
  const selectedGroup =
    switchGroups.find((group) => group.key === selectedRuntimeKey) ?? switchGroups[0]
  const activeTarget = selectedGroup?.targets.find((target) => target.active)
  const accountRows: AccountSwitchListRow[] = (selectedGroup?.targets ?? []).map((target) => {
    const inactiveUsage = target.id
      ? inactiveClaudeAccounts.find((a) => a.accountId === target.id)
      : null
    // Why local only: the hidden sign-in runs on this device, not a remote server.
    const signInId = target.needsSignIn && !hasActiveRuntimeEnvironment ? target.id : null
    // Why: rows follow this desktop's claudeTarget, so a remote owner's usage could land on the wrong row.
    const limits = target.active
      ? hasActiveRuntimeEnvironment
        ? null
        : claude
      : (inactiveUsage?.rateLimits ?? null)
    // Why: the sign-in hint already says this; skip the repeat.
    const showUsage = !(signInId && isUnavailableInactiveUsage(limits))
    return {
      key: `${selectedGroup?.key}:${target.id ?? 'system'}`,
      title: target.label,
      email: target.email,
      systemDefaultEmail: target.systemDefaultEmail,
      workspace: target.workspace ?? null,
      identifier: target.identifier ?? null,
      usage: showUsage ? getAccountSwitchUsage(limits) : { kind: 'none' },
      needsSignIn: target.needsSignIn === true,
      active: target.active,
      disabled:
        !target.active &&
        (isSwitching || signingInId !== null || (signInId === null && target.disabled === true)),
      isFetching: target.active
        ? claude.status === 'fetching'
        : (inactiveUsage?.isFetching ?? false) && !inactiveUsage?.rateLimits,
      statusLabel: showUsage ? getAccountSwitchStatusLabel(limits) : null,
      hint: target.hint ?? null,
      signIn: signInId
        ? {
            isSigningIn: signingInId === signInId,
            disabled: isSwitching || signingInId !== null,
            onSignIn: () => void handleSignIn(signInId)
          }
        : null,
      onSelect: () => {
        if (signInId) {
          void handleSignIn(signInId)
        } else {
          void handleSelectAccount(target.id, target.runtimeTarget)
        }
      }
    }
  })

  return (
    <ProviderDetailsMenu
      provider={claude}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.3dd7ddfae1',
        'Open Claude details and account switcher'
      )}
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={(group) => void handleSelectRuntime(group)}
          ariaLabel={translate(
            'auto.components.status.bar.StatusBar.11e2354daf',
            'Claude usage runtime'
          )}
        />
      }
      wide
      identity={
        // Why: a remote owner's usage may belong to another runtime lane than the row picked here.
        activeTarget && !hasActiveRuntimeEnvironment ? (
          <AccountIdentityHeader
            email={activeTarget.email}
            systemDefaultEmail={activeTarget.systemDefaultEmail}
            workspace={activeTarget.workspace ?? null}
            identifier={activeTarget.identifier ?? null}
          />
        ) : undefined
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <AccountSwitchList
        heading={translate('auto.components.status.bar.StatusBar.d450654fa2', 'Claude Account')}
        rows={accountRows}
        display={usagePercentageDisplay}
      />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-claude'
          })
          openSettingsPage()
        }}
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}

import { ChevronDown, ChevronRight } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  fetchProviderAccountsSnapshot,
  selectClaudeProviderAccount
} from '@/runtime/runtime-provider-accounts-client'
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
  normalizeClaudeStatusRuntimeTarget,
  resolveClaudeStatusAccountState
} from './status-bar-claude-accounts'
import { AccountRuntimeToggle } from './StatusBarAccountControls'
import { InlineUsageBars, InlineUsageSkeleton } from './InlineProviderUsage'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'

// Exported so its account-switch/reset logic is preserved for row drill-in even
// though the footer now opens the consolidated UsageRosterPanel first.
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
  const [accountsExpanded, setAccountsExpanded] = useState(false)
  const [accounts, setAccounts] = useState<ClaudeRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
  const [isSwitching, setIsSwitching] = useState(false)
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
  const claudeAccountSyncKey = useAppStore((s) => {
    const settings = s.settings
    if (!settings) {
      return 'no-settings'
    }
    return `${settings.activeRuntimeEnvironmentId?.trim() || 'local'}:${settings.activeClaudeManagedAccountId ?? 'system'}:${JSON.stringify(settings.activeClaudeManagedAccountIdsByRuntime ?? null)}:${settings.claudeManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  })
  const accountState = resolveClaudeStatusAccountState(settings, accounts)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim() || null
  // Why: keyed on owner id, not settings identity, so routine settings mutations don't re-run the remote snapshot fetch.
  const loadAccounts = useCallback(async () => {
    const snapshot = await fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId })
    // Why: a failed Claude half is a substituted empty roster; keep prior state.
    if (snapshot.failedProviders?.includes('claude')) {
      console.error('Claude account list failed; keeping previous status bar state.')
      return
    }
    if (mountedRef.current) {
      setAccounts(snapshot.claude)
    }
  }, [activeRuntimeEnvironmentId])

  useEffect(() => {
    void loadAccounts().catch((error) => {
      console.error('Failed to load Claude accounts for status bar:', error)
    })
  }, [loadAccounts, claudeAccountSyncKey])

  const handleOpenChange = useCallback((nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setAccountsExpanded(false)
    }
  }, [])

  // Why: fetch inactive-account usage only on switcher expansion; remote-owned accounts have no local cache to fill.
  const handleAccountsExpandedToggle = useCallback((): void => {
    const nextExpanded = !accountsExpanded
    setAccountsExpanded(nextExpanded)
    if (nextExpanded && !hasActiveRuntimeEnvironment) {
      void fetchInactiveClaudeAccountUsage()
    }
  }, [accountsExpanded, fetchInactiveClaudeAccountUsage, hasActiveRuntimeEnvironment])

  const handleSelectAccount = async (
    accountId: string | null,
    target: CodexStatusRuntimeTarget
  ): Promise<void> => {
    if (isSwitching) {
      return
    }
    setIsSwitching(true)
    try {
      const next = await selectClaudeProviderAccount(settings, {
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
      if (mountedRef.current) {
        setAccountsExpanded(false)
      }
    } catch (error) {
      console.error('Failed to switch Claude account from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsSwitching(false)
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
    setAccountsExpanded(false)
    try {
      await refreshClaudeRateLimitsForTarget(group.runtimeTarget)
    } catch (error) {
      console.error('Failed to switch Claude usage runtime:', error)
    }
  }

  const selectedRuntimeKey = getCodexStatusRuntimeKey(
    normalizeClaudeStatusRuntimeTarget(accountState, toCodexStatusRuntimeTarget(claudeTarget))
  )
  const fallbackWslDistro = getStatusBarPreferredWslDistro(
    settings,
    windowsTerminalCapabilities.wslDistros
  )
  const switchGroups = buildClaudeStatusSwitchGroups(
    accountState,
    toCodexStatusRuntimeTarget(claudeTarget),
    {
      fallbackWslDistro,
      includeFallbackWsl: !hasActiveRuntimeEnvironment && shouldIncludeSettingsWslRuntime(settings),
      hostLabel: providerAccountHostLabel
    }
  )
  const selectedGroup =
    switchGroups.find((group) => group.key === selectedRuntimeKey) ?? switchGroups[0]
  const activeTarget = selectedGroup?.targets.find((target) => target.active)

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
      open={open}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenuLabel>
        {translate('auto.components.status.bar.StatusBar.d450654fa2', 'Claude Account')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          handleAccountsExpandedToggle()
        }}
      >
        <span className="max-w-[180px] truncate text-[12px] text-foreground">
          {activeTarget?.label ??
            translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')}
        </span>
        {accountsExpanded ? (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/85" />
        ) : (
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground/85" />
        )}
      </DropdownMenuItem>
      {accountsExpanded ? (
        <div className="px-1 pb-1">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {translate('auto.components.status.bar.StatusBar.9332ba8684', 'Switch to')}
          </div>
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
            {selectedGroup?.targets.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                {translate('auto.components.status.bar.StatusBar.c98ea88392', 'No other accounts')}
              </div>
            ) : null}
            {selectedGroup?.targets.map((target) => {
              const inactiveUsage = target.id
                ? inactiveClaudeAccounts.find((a) => a.accountId === target.id)
                : null

              return (
                <DropdownMenuItem
                  key={`${selectedGroup.key}:${target.id ?? 'system'}`}
                  disabled={isSwitching || target.active}
                  onSelect={(event) => {
                    event.preventDefault()
                    if (!target.active) {
                      void handleSelectAccount(target.id, target.runtimeTarget)
                    }
                  }}
                >
                  <div className="flex w-full flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{target.label}</span>
                      {target.active ? (
                        <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                          {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
                        </span>
                      ) : null}
                    </div>
                    {inactiveUsage?.isFetching && !inactiveUsage.rateLimits ? (
                      <InlineUsageSkeleton />
                    ) : inactiveUsage?.rateLimits ? (
                      <InlineUsageBars
                        limits={inactiveUsage.rateLimits}
                        isFetching={inactiveUsage.isFetching}
                      />
                    ) : null}
                  </div>
                </DropdownMenuItem>
              )
            })}
          </div>
          <div className="px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
            {translate(
              'auto.components.status.bar.StatusBar.8295903d17',
              'Restart live Claude terminals before continuing old conversations after switching.'
            )}
          </div>
        </div>
      ) : null}
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

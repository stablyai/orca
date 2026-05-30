/* eslint-disable max-lines -- Why: the status bar keeps provider rendering,
interaction menus, and compact-layout behavior together so the hover/click
states stay consistent across Claude and Codex. */
import {
  AlertTriangle,
  Activity,
  Plug,
  ChevronDown,
  ChevronRight,
  Loader2,
  PanelsTopLeft,
  RefreshCw,
  Server
} from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  GlobalSettings
} from '../../../../shared/types'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitWindow
} from '../../../../shared/rate-limit-types'
import { ProviderIcon, ProviderPanel, barColor } from './tooltip'
import { ClaudeIcon, GeminiIcon, OpenAIIcon, OpenCodeGoIcon } from './icons'
import { formatWindowLabel } from '@/lib/window-label-formatter'
import { markLiveCodexSessionsForRestart } from '@/lib/codex-session-restart'
import { SshStatusSegment } from './SshStatusSegment'
import { UpdateStatusSegment } from './UpdateStatusSegment'
import { ResourceUsageStatusSegment } from './ResourceUsageStatusSegment'
import { PortsStatusSegment } from './PortsStatusSegment'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import { shouldOpenStatusBarContextMenu } from './status-bar-context-menu-policy'
import { PetStatusSegment } from './PetStatusSegment'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { FloatingTerminalIconContextMenu } from '@/components/floating-terminal/FloatingTerminalIconContextMenu'
import { summarizeCodexRestartStatus } from './codex-restart-status-summary'
import { useWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'

type StatusBarProps = {
  floatingTerminalOpen: boolean
}

export type CodexStatusRuntimeTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

type CodexStatusAccount = CodexRateLimitAccountsState['accounts'][number]
type ClaudeStatusAccount = ClaudeRateLimitAccountsState['accounts'][number]

export type CodexStatusSwitchTarget = {
  id: string | null
  label: string
  active: boolean
  runtimeTarget: CodexStatusRuntimeTarget
}

export type CodexStatusSwitchGroup = {
  key: string
  label: string
  runtimeTarget: CodexStatusRuntimeTarget
  targets: CodexStatusSwitchTarget[]
}

export type ClaudeStatusSwitchTarget = {
  id: string | null
  label: string
  active: boolean
  runtimeTarget: CodexStatusRuntimeTarget
}

export type ClaudeStatusSwitchGroup = {
  key: string
  label: string
  runtimeTarget: CodexStatusRuntimeTarget
  targets: ClaudeStatusSwitchTarget[]
}

type StatusSwitchGroupOptions = {
  fallbackWslDistro?: string | null
  includeFallbackWsl?: boolean
}

function getHostRuntimeLabel(): string {
  return navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'
}

function getCodexAccountLabel(
  state: CodexRateLimitAccountsState,
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return 'System default'
  }
  return state.accounts.find((account) => account.id === accountId)?.email ?? 'Codex account'
}

function getCodexAccountDisplayLabel(account: CodexStatusAccount): string {
  return account.workspaceLabel ? `${account.email} (${account.workspaceLabel})` : account.email
}

function getCodexStatusWslKey(wslDistro: string | null | undefined): string {
  const trimmed = wslDistro?.trim()
  return trimmed ? trimmed : '__default__'
}

function getCodexStatusRuntimeLabel(target: CodexStatusRuntimeTarget): string {
  if (target.runtime === 'host') {
    return getHostRuntimeLabel()
  }
  return target.wslDistro ? `WSL ${target.wslDistro}` : 'WSL default'
}

function getCodexStatusRuntimeKey(target: CodexStatusRuntimeTarget): string {
  return target.runtime === 'host' ? 'host' : `wsl:${getCodexStatusWslKey(target.wslDistro)}`
}

function toCodexStatusRuntimeTarget(
  target: RateLimitRuntimeTarget | undefined
): CodexStatusRuntimeTarget {
  if (target?.runtime === 'wsl') {
    return { runtime: 'wsl', wslDistro: target.wslDistro }
  }
  return { runtime: 'host', wslDistro: null }
}

function getStatusBarPreferredWslDistro(
  settings: GlobalSettings | null | undefined,
  wslDistros: string[]
): string | null {
  const configuredDistro =
    settings?.localAccountWslDistro?.trim() || settings?.terminalWindowsWslDistro?.trim() || null
  if (configuredDistro) {
    return configuredDistro
  }
  return wslDistros.length === 1 ? wslDistros[0] : null
}

function shouldIncludeSettingsWslRuntime(settings: GlobalSettings | null | undefined): boolean {
  return settings?.localAccountRuntime === 'wsl'
}

function getSingleConcreteCodexWslDistro(state: CodexRateLimitAccountsState): string | null {
  const keys = new Set<string>()
  for (const [key, accountId] of Object.entries(state.activeAccountIdsByRuntime?.wsl ?? {})) {
    if (accountId && key !== '__default__') {
      keys.add(key)
    }
  }
  for (const account of state.accounts) {
    const key = getCodexStatusWslKey(account.wslDistro)
    if (account.managedHomeRuntime === 'wsl' && key !== '__default__') {
      keys.add(key)
    }
  }
  return keys.size === 1 ? Array.from(keys)[0] : null
}

function normalizeCodexStatusRuntimeTarget(
  state: CodexRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): CodexStatusRuntimeTarget {
  if (target.runtime !== 'wsl' || target.wslDistro) {
    return target
  }
  const concreteDistro = getSingleConcreteCodexWslDistro(state)
  return concreteDistro ? { runtime: 'wsl', wslDistro: concreteDistro } : target
}

function getCodexStatusActiveId(
  state: CodexRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): string | null {
  const selection = state.activeAccountIdsByRuntime
  if (target.runtime === 'host') {
    return selection?.host ?? state.activeAccountId ?? null
  }
  const distroSelection = selection?.wsl?.[getCodexStatusWslKey(target.wslDistro)]
  if (target.wslDistro || distroSelection) {
    return distroSelection ?? null
  }
  const selectedIds = Array.from(new Set(Object.values(selection?.wsl ?? {}).filter(Boolean)))
  return selectedIds.length === 1 ? selectedIds[0] : null
}

function getCodexStatusAccountsForTarget(
  state: CodexRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): CodexStatusAccount[] {
  if (target.runtime === 'host') {
    return state.accounts.filter((account) => account.managedHomeRuntime !== 'wsl')
  }
  return state.accounts.filter(
    (account) =>
      account.managedHomeRuntime === 'wsl' &&
      getCodexStatusWslKey(account.wslDistro) === getCodexStatusWslKey(target.wslDistro)
  )
}

export function buildCodexStatusSwitchGroups(
  state: CodexRateLimitAccountsState,
  currentTarget: CodexStatusRuntimeTarget,
  options: StatusSwitchGroupOptions = {}
): CodexStatusSwitchGroup[] {
  const groups: CodexStatusSwitchGroup[] = []
  const normalizedCurrentTarget = normalizeCodexStatusRuntimeTarget(state, currentTarget)
  const makeGroup = (target: CodexStatusRuntimeTarget): CodexStatusSwitchGroup => {
    const activeId = getCodexStatusActiveId(state, target)
    const accountsForTarget = getCodexStatusAccountsForTarget(state, target)
    return {
      key: getCodexStatusRuntimeKey(target),
      label: getCodexStatusRuntimeLabel(target),
      runtimeTarget: target,
      targets: [
        {
          id: null,
          label: 'System default',
          active: activeId === null,
          runtimeTarget: target
        },
        ...accountsForTarget.map((account) => ({
          id: account.id,
          label: getCodexAccountDisplayLabel(account),
          active: account.id === activeId,
          runtimeTarget: target
        }))
      ]
    }
  }

  groups.push(makeGroup({ runtime: 'host', wslDistro: null }))

  const wslKeys = new Set<string>(Object.keys(state.activeAccountIdsByRuntime?.wsl ?? {}))
  if (normalizedCurrentTarget.runtime === 'wsl') {
    wslKeys.add(getCodexStatusWslKey(normalizedCurrentTarget.wslDistro))
  }
  for (const account of state.accounts) {
    if (account.managedHomeRuntime === 'wsl') {
      wslKeys.add(getCodexStatusWslKey(account.wslDistro))
    }
  }
  if (options.includeFallbackWsl) {
    wslKeys.add(getCodexStatusWslKey(options.fallbackWslDistro))
  }
  if (currentTarget.runtime === 'wsl' && currentTarget.wslDistro === null) {
    const concreteDistro = getSingleConcreteCodexWslDistro(state)
    if (concreteDistro) {
      wslKeys.delete('__default__')
    }
  }

  for (const key of Array.from(wslKeys).sort((a, b) => {
    if (a === '__default__') {
      return -1
    }
    if (b === '__default__') {
      return 1
    }
    return a.localeCompare(b)
  })) {
    groups.push(makeGroup({ runtime: 'wsl', wslDistro: key === '__default__' ? null : key }))
  }

  return groups
}

function getCodexStatusAccountsFromSettings(
  settings: GlobalSettings | null | undefined
): CodexRateLimitAccountsState | null {
  if (!settings) {
    return null
  }
  return {
    accounts: settings.codexManagedAccounts
      .map((account) => ({
        id: account.id,
        email: account.email,
        managedHomeRuntime: account.managedHomeRuntime ?? 'host',
        wslDistro: account.wslDistro ?? null,
        providerAccountId: account.providerAccountId ?? null,
        workspaceLabel: account.workspaceLabel ?? null,
        workspaceAccountId: account.workspaceAccountId ?? null,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        lastAuthenticatedAt: account.lastAuthenticatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    activeAccountId:
      settings.activeCodexManagedAccountIdsByRuntime?.host ??
      settings.activeCodexManagedAccountId ??
      null,
    activeAccountIdsByRuntime: {
      host:
        settings.activeCodexManagedAccountIdsByRuntime?.host ??
        settings.activeCodexManagedAccountId ??
        null,
      wsl: { ...settings.activeCodexManagedAccountIdsByRuntime?.wsl }
    }
  }
}

function getSingleConcreteClaudeWslDistro(state: ClaudeRateLimitAccountsState): string | null {
  const keys = new Set<string>()
  for (const [key, accountId] of Object.entries(state.activeAccountIdsByRuntime?.wsl ?? {})) {
    if (accountId && key !== '__default__') {
      keys.add(key)
    }
  }
  for (const account of state.accounts) {
    const key = getCodexStatusWslKey(account.wslDistro)
    if (account.managedAuthRuntime === 'wsl' && key !== '__default__') {
      keys.add(key)
    }
  }
  return keys.size === 1 ? Array.from(keys)[0] : null
}

function normalizeClaudeStatusRuntimeTarget(
  state: ClaudeRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): CodexStatusRuntimeTarget {
  if (target.runtime !== 'wsl' || target.wslDistro) {
    return target
  }
  const concreteDistro = getSingleConcreteClaudeWslDistro(state)
  return concreteDistro ? { runtime: 'wsl', wslDistro: concreteDistro } : target
}

function getClaudeStatusActiveId(
  state: ClaudeRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): string | null {
  const selection = state.activeAccountIdsByRuntime
  if (target.runtime === 'host') {
    return selection?.host ?? state.activeAccountId ?? null
  }
  const distroSelection = selection?.wsl?.[getCodexStatusWslKey(target.wslDistro)]
  if (target.wslDistro || distroSelection) {
    return distroSelection ?? null
  }
  const selectedIds = Array.from(new Set(Object.values(selection?.wsl ?? {}).filter(Boolean)))
  return selectedIds.length === 1 ? selectedIds[0] : null
}

function getClaudeStatusAccountsForTarget(
  state: ClaudeRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): ClaudeStatusAccount[] {
  if (target.runtime === 'host') {
    return state.accounts.filter((account) => account.managedAuthRuntime !== 'wsl')
  }
  return state.accounts.filter(
    (account) =>
      account.managedAuthRuntime === 'wsl' &&
      getCodexStatusWslKey(account.wslDistro) === getCodexStatusWslKey(target.wslDistro)
  )
}

export function buildClaudeStatusSwitchGroups(
  state: ClaudeRateLimitAccountsState,
  currentTarget: CodexStatusRuntimeTarget,
  options: StatusSwitchGroupOptions = {}
): ClaudeStatusSwitchGroup[] {
  const groups: ClaudeStatusSwitchGroup[] = []
  const normalizedCurrentTarget = normalizeClaudeStatusRuntimeTarget(state, currentTarget)
  const makeGroup = (target: CodexStatusRuntimeTarget): ClaudeStatusSwitchGroup => {
    const activeId = getClaudeStatusActiveId(state, target)
    const accountsForTarget = getClaudeStatusAccountsForTarget(state, target)
    return {
      key: getCodexStatusRuntimeKey(target),
      label: getCodexStatusRuntimeLabel(target),
      runtimeTarget: target,
      targets: [
        {
          id: null,
          label: 'System default',
          active: activeId === null,
          runtimeTarget: target
        },
        ...accountsForTarget.map((account) => ({
          id: account.id,
          label: account.email,
          active: account.id === activeId,
          runtimeTarget: target
        }))
      ]
    }
  }

  groups.push(makeGroup({ runtime: 'host', wslDistro: null }))

  const wslKeys = new Set<string>(Object.keys(state.activeAccountIdsByRuntime?.wsl ?? {}))
  if (normalizedCurrentTarget.runtime === 'wsl') {
    wslKeys.add(getCodexStatusWslKey(normalizedCurrentTarget.wslDistro))
  }
  for (const account of state.accounts) {
    if (account.managedAuthRuntime === 'wsl') {
      wslKeys.add(getCodexStatusWslKey(account.wslDistro))
    }
  }
  if (options.includeFallbackWsl) {
    wslKeys.add(getCodexStatusWslKey(options.fallbackWslDistro))
  }
  if (currentTarget.runtime === 'wsl' && currentTarget.wslDistro === null) {
    const concreteDistro = getSingleConcreteClaudeWslDistro(state)
    if (concreteDistro) {
      wslKeys.delete('__default__')
    }
  }

  for (const key of Array.from(wslKeys).sort((a, b) => {
    if (a === '__default__') {
      return -1
    }
    if (b === '__default__') {
      return 1
    }
    return a.localeCompare(b)
  })) {
    groups.push(makeGroup({ runtime: 'wsl', wslDistro: key === '__default__' ? null : key }))
  }

  return groups
}

function getClaudeStatusAccountsFromSettings(
  settings: GlobalSettings | null | undefined
): ClaudeRateLimitAccountsState | null {
  if (!settings) {
    return null
  }
  return {
    accounts: settings.claudeManagedAccounts
      .map((account) => ({
        id: account.id,
        email: account.email,
        managedAuthRuntime: account.managedAuthRuntime ?? 'host',
        wslDistro: account.wslDistro ?? null,
        authMethod: account.authMethod ?? 'unknown',
        organizationUuid: account.organizationUuid ?? null,
        organizationName: account.organizationName ?? null,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        lastAuthenticatedAt: account.lastAuthenticatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    activeAccountId:
      settings.activeClaudeManagedAccountIdsByRuntime?.host ??
      settings.activeClaudeManagedAccountId ??
      null,
    activeAccountIdsByRuntime: {
      host:
        settings.activeClaudeManagedAccountIdsByRuntime?.host ??
        settings.activeClaudeManagedAccountId ??
        null,
      wsl: { ...settings.activeClaudeManagedAccountIdsByRuntime?.wsl }
    }
  }
}

function CodexRestartStatusPrompt(): React.JSX.Element | null {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const codexRestartNoticeByPtyId = useAppStore((s) => s.codexRestartNoticeByPtyId)
  const queueCodexPaneRestarts = useAppStore((s) => s.queueCodexPaneRestarts)

  const staleCodexStatus = useMemo(
    () =>
      summarizeCodexRestartStatus({
        tabsByWorktree,
        ptyIdsByTabId,
        codexRestartNoticeByPtyId
      }),
    [codexRestartNoticeByPtyId, ptyIdsByTabId, tabsByWorktree]
  )

  if (staleCodexStatus.staleTabCount === 0) {
    return null
  }

  return (
    <>
      <DropdownMenuSeparator />
      <div className="px-2 py-2">
        <div className="text-[11px] text-muted-foreground">
          {/* Why: stale restart notices are tracked per PTY session, but the
          bulk restart action operates per PTY-backed pane restart. Show
          both counts so split panes do not make the number look wrong. */}
          {staleCodexStatus.staleSessionCount === 1
            ? '1 Codex session is still on the old account'
            : `${staleCodexStatus.staleSessionCount} Codex sessions are still on the old account.`}
          {staleCodexStatus.staleWorktreeCount > 1 ? (
            <span className="mt-0.5 block">
              Visible sessions restart now. Others restart when their worktree becomes active.
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => queueCodexPaneRestarts(staleCodexStatus.stalePtyIds)}
          className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
        >
          {staleCodexStatus.staleSessionCount === 1
            ? 'Restart Session'
            : `Restart ${staleCodexStatus.staleSessionCount} Sessions`}
        </button>
      </div>
    </>
  )
}

function AccountRuntimeToggle<TGroup extends { key: string; label: string }>({
  groups,
  value,
  onChange,
  ariaLabel
}: {
  groups: TGroup[]
  value: string
  onChange: (group: TGroup) => void
  ariaLabel: string
}): React.JSX.Element | null {
  if (groups.length <= 1) {
    return null
  }

  return (
    <div className="px-2 pt-2">
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="inline-flex w-full items-center rounded-md border border-border bg-background/50 p-0.5"
      >
        {groups.map((group) => {
          const active = group.key === value
          return (
            <button
              key={group.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(group)}
              className={`min-w-0 flex-1 rounded-sm px-2 py-1 text-center text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="block truncate">{group.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ClaudeSwitcherMenu({
  claude,
  compact,
  iconOnly
}: {
  claude: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [accountsExpanded, setAccountsExpanded] = useState(false)
  const [accounts, setAccounts] = useState<ClaudeRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
  const [isSwitching, setIsSwitching] = useState(false)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshClaudeRateLimitsForTarget = useAppStore((s) => s.refreshClaudeRateLimitsForTarget)
  const fetchInactiveClaudeAccountUsage = useAppStore((s) => s.fetchInactiveClaudeAccountUsage)
  const inactiveClaudeAccounts = useAppStore((s) => s.rateLimits.inactiveClaudeAccounts)
  const claudeTarget = useAppStore((s) => s.rateLimits.claudeTarget)
  const settings = useAppStore((s) => s.settings)
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows')
  )
  const claudeAccountSyncKey = useAppStore((s) => {
    const settings = s.settings
    if (!settings) {
      return 'no-settings'
    }
    return `${settings.activeClaudeManagedAccountId ?? 'system'}:${JSON.stringify(settings.activeClaudeManagedAccountIdsByRuntime ?? null)}:${settings.claudeManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  })
  const accountState = getClaudeStatusAccountsFromSettings(settings) ?? accounts

  const loadAccounts = useCallback(async () => {
    const next = await window.api.claudeAccounts.list()
    setAccounts(next)
  }, [])

  useEffect(() => {
    void loadAccounts().catch((error) => {
      console.error('Failed to load Claude accounts for status bar:', error)
    })
  }, [loadAccounts, open, claudeAccountSyncKey])

  const handleOpenChange = useCallback((nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setAccountsExpanded(false)
    }
  }, [])

  useEffect(() => {
    if (accountsExpanded) {
      void fetchInactiveClaudeAccountUsage()
    }
  }, [accountsExpanded, fetchInactiveClaudeAccountUsage])

  const handleSelectAccount = async (
    accountId: string | null,
    target: CodexStatusRuntimeTarget
  ): Promise<void> => {
    if (isSwitching) {
      return
    }
    setIsSwitching(true)
    try {
      const next = await window.api.claudeAccounts.select({
        accountId,
        runtime: target.runtime,
        wslDistro: target.wslDistro
      })
      recordFeatureInteraction('claude-account-switching')
      setAccounts(next)
      await fetchSettings()
      setAccountsExpanded(false)
    } catch (error) {
      console.error('Failed to switch Claude account from status bar:', error)
    } finally {
      setIsSwitching(false)
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
      includeFallbackWsl: shouldIncludeSettingsWslRuntime(settings)
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
      ariaLabel="Open Claude details and account switcher"
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={(group) => void handleSelectRuntime(group)}
          ariaLabel="Claude usage runtime"
        />
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenuLabel>Claude Account</DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          setAccountsExpanded((prev) => !prev)
        }}
      >
        <span className="max-w-[180px] truncate text-[12px] text-foreground">
          {activeTarget?.label ?? 'System default'}
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
            Switch to
          </div>
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
            {selectedGroup?.targets.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">No other accounts</div>
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
                          Active
                        </span>
                      ) : null}
                    </div>
                    {inactiveUsage?.isFetching && !inactiveUsage.claude ? (
                      <InlineUsageSkeleton />
                    ) : inactiveUsage?.claude ? (
                      <InlineUsageBars
                        limits={inactiveUsage.claude}
                        isFetching={inactiveUsage.isFetching}
                      />
                    ) : null}
                  </div>
                </DropdownMenuItem>
              )
            })}
          </div>
          <div className="px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
            Restart live Claude terminals before continuing old conversations after switching.
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
        Manage Accounts…
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}

// ---------------------------------------------------------------------------
// Mini progress bar (shows remaining capacity, grey)
// ---------------------------------------------------------------------------

function MiniBar({ leftPct }: { leftPct: number }): React.JSX.Element {
  return (
    <div className="w-[48px] h-[6px] rounded-full bg-muted overflow-hidden flex-shrink-0">
      <div
        className="h-full rounded-full transition-all duration-300 bg-muted-foreground/40"
        style={{ width: `${Math.min(100, Math.max(0, leftPct))}%` }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline usage bars (compact bars for inactive accounts in the switcher)
// ---------------------------------------------------------------------------

function InlineUsageBars({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits
  isFetching: boolean
}): React.JSX.Element {
  const sessionLeft = limits.session
    ? Math.max(0, Math.round(100 - limits.session.usedPercent))
    : null
  const weeklyLeft = limits.weekly ? Math.max(0, Math.round(100 - limits.weekly.usedPercent)) : null

  return (
    <div className={`flex w-full items-center gap-2 ${isFetching ? 'animate-pulse' : ''}`}>
      {sessionLeft !== null && (
        <div className="flex flex-1 items-center gap-1">
          <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${barColor(sessionLeft)}`}
              style={{ width: `${sessionLeft}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
            {sessionLeft}% 5h
          </span>
        </div>
      )}
      {weeklyLeft !== null && (
        <div className="flex flex-1 items-center gap-1">
          <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${barColor(weeklyLeft)}`}
              style={{ width: `${weeklyLeft}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
            {weeklyLeft}% wk
          </span>
        </div>
      )}
      {limits.status === 'error' && !limits.session && !limits.weekly && (
        <span className="text-[10px] text-muted-foreground">Sign in to see usage</span>
      )}
    </div>
  )
}

function isUnavailableInactiveUsage(limits: ProviderRateLimits | null | undefined): boolean {
  return limits?.status === 'error' && !limits.session && !limits.weekly
}

function InlineUsageSignInAction({
  isFetching,
  isSigningIn,
  disabled,
  onSignInPointerDown,
  onSignIn
}: {
  isFetching: boolean
  isSigningIn: boolean
  disabled: boolean
  onSignInPointerDown?: () => void
  onSignIn: () => void
}): React.JSX.Element {
  return (
    <div className={`flex w-full items-center gap-2 ${isFetching ? 'animate-pulse' : ''}`}>
      <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">Sign in to see usage</span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        className="h-6 shrink-0 px-2 text-muted-foreground hover:text-foreground"
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSignInPointerDown?.()
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSignIn()
        }}
      >
        {isSigningIn ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        Sign in
      </Button>
    </div>
  )
}

function InlineUsageSkeleton(): React.JSX.Element {
  return (
    <div className="flex w-full animate-pulse items-center gap-2">
      <div className="h-[4px] flex-1 rounded-full bg-muted" />
      <div className="h-[4px] flex-1 rounded-full bg-muted" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Window label (shows percent remaining)
// ---------------------------------------------------------------------------

function WindowLabel({ w, label }: { w: RateLimitWindow; label: string }): React.JSX.Element {
  const left = Math.max(0, Math.round(100 - w.usedPercent))
  return (
    <span className="tabular-nums">
      {left}% {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Provider segment
// ---------------------------------------------------------------------------

// Why: only Flash and the latest Pro are shown in the status bar —
// the rest (Flash Lite, experimental) are secondary and would clutter the bar.
const STATUS_BAR_BUCKET_NAMES = new Set(['Flash', 'Pro', '1.5 Pro'])

function ProviderSegment({
  p,
  compact
}: {
  p: ProviderRateLimits | null
  compact: boolean
}): React.JSX.Element {
  const provider = p?.provider ?? 'claude'
  const statusLabel = p?.error && /rate limit/i.test(p.error) ? 'Limited' : 'Unavailable'

  // Idle / initial load
  if (!p || p.status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">&middot;&middot;&middot;</span>
      </span>
    )
  }

  // Fetching with no prior data
  if (p.status === 'fetching' && !p.session && !p.weekly) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">&middot;&middot;&middot;</span>
      </span>
    )
  }

  // Unavailable (CLI not installed)
  if (p.status === 'unavailable') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/50">
        <ProviderIcon provider={provider} /> --
      </span>
    )
  }

  // Error with no data
  if (p.status === 'error' && !p.session && !p.weekly) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <AlertTriangle size={11} className="text-muted-foreground/80" />
        {!compact && <span className="text-[11px] font-medium">{statusLabel}</span>}
      </span>
    )
  }

  // Has data (ok, fetching with stale data, or error with stale data)
  const isStale = p.status === 'error'

  if (p.buckets && p.buckets.length > 0) {
    const visibleBuckets = p.buckets.filter((b) => STATUS_BAR_BUCKET_NAMES.has(b.name))
    return (
      <span className="inline-flex items-center gap-1.5">
        <ProviderIcon provider={provider} />
        {visibleBuckets.map((bucket, i) => {
          const left = Math.max(0, Math.round(100 - bucket.usedPercent))
          return (
            <React.Fragment key={bucket.name}>
              {i > 0 && <span className="text-muted-foreground">&middot;</span>}
              <span className="tabular-nums">
                {bucket.name} {left}%
              </span>
            </React.Fragment>
          )
        })}
        {visibleBuckets.length === 0 && p.session && (
          <WindowLabel w={p.session} label={formatWindowLabel(p.session.windowMinutes)} />
        )}
        {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {p.session && !compact && <MiniBar leftPct={Math.max(0, 100 - p.session.usedPercent)} />}
      {p.session && (
        <WindowLabel w={p.session} label={formatWindowLabel(p.session.windowMinutes)} />
      )}
      {p.session && p.weekly && <span className="text-muted-foreground">&middot;</span>}
      {p.weekly && <WindowLabel w={p.weekly} label={formatWindowLabel(p.weekly.windowMinutes)} />}
      {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
    </span>
  )
}

function CodexSwitcherMenu({
  codex,
  compact,
  iconOnly
}: {
  codex: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [accountsExpanded, setAccountsExpanded] = useState(false)
  const [accounts, setAccounts] = useState<CodexRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null
  })
  const [isSwitching, setIsSwitching] = useState(false)
  const [reauthenticatingAccountId, setReauthenticatingAccountId] = useState<string | null>(null)
  const accountsExpandedRef = useRef(accountsExpanded)
  // Why: Radix item selection is separate from the nested button click, so
  // propagation stops alone do not prevent the row switch action.
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
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const refreshCodexRateLimitsForTarget = useAppStore((s) => s.refreshCodexRateLimitsForTarget)
  const fetchInactiveCodexAccountUsage = useAppStore((s) => s.fetchInactiveCodexAccountUsage)
  const inactiveCodexAccounts = useAppStore((s) => s.rateLimits.inactiveCodexAccounts)
  const codexTarget = useAppStore((s) => s.rateLimits.codexTarget)
  const settings = useAppStore((s) => s.settings)
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows')
  )
  const codexAccountSyncKey = useAppStore((s) => {
    const settings = s.settings
    if (!settings) {
      return 'no-settings'
    }
    return `${settings.activeCodexManagedAccountId ?? 'system'}:${JSON.stringify(settings.activeCodexManagedAccountIdsByRuntime ?? null)}:${settings.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  })
  const accountState = getCodexStatusAccountsFromSettings(settings) ?? accounts

  const loadAccounts = useCallback(async () => {
    const next = await window.api.codexAccounts.list()
    setAccounts(next)
  }, [])

  useEffect(() => {
    accountsExpandedRef.current = accountsExpanded
  }, [accountsExpanded])

  useEffect(() => {
    // Why: the status bar keeps its own lightweight account snapshot for the
    // dropdown. Settings account actions mutate the main-process store outside
    // this component, so we refresh when the persisted account roster changes
    // or when the menu opens instead of leaving a stale account list mounted.
    void loadAccounts().catch((error) => {
      console.error('Failed to load Codex accounts for status bar:', error)
    })
  }, [loadAccounts, open, codexAccountSyncKey])

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
      const next = await window.api.codexAccounts.select({
        accountId,
        runtime: target.runtime,
        wslDistro: target.wslDistro
      })
      recordFeatureInteraction('codex-account-switching')
      setAccounts(next)
      await fetchSettings()
      const nextActiveAccountId = getCodexStatusActiveId(next, target)
      if (previousActiveAccountId !== nextActiveAccountId) {
        await markLiveCodexSessionsForRestart({
          previousAccountLabel: getCodexAccountLabel(accountState, previousActiveAccountId),
          nextAccountLabel: getCodexAccountLabel(next, nextActiveAccountId)
        })
        // Why: account switching can require a second explicit recovery step
        // for live Codex terminals. Keeping the switcher open and collapsing
        // back to the summary row lets the follow-up "restart open tabs"
        // prompt appear in the same flow instead of feeling detached.
        setAccountsExpanded(false)
      }
    } catch (error) {
      console.error('Failed to switch Codex account from status bar:', error)
    } finally {
      setIsSwitching(false)
    }
  }

  const handleSignInAccount = async (accountId: string): Promise<void> => {
    if (isSwitching || reauthenticatingAccountId !== null) {
      return
    }
    setReauthenticatingAccountId(accountId)
    try {
      const next = await window.api.codexAccounts.reauthenticate({ accountId })
      recordFeatureInteraction('codex-account-switching')
      setAccounts(next)
      await fetchSettings()
      if (accountsExpandedRef.current) {
        await fetchInactiveCodexAccountUsage()
      }
    } catch (error) {
      console.error('Failed to re-authenticate Codex account from status bar:', error)
    } finally {
      setReauthenticatingAccountId(null)
    }
  }

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

  const handleOpenChange = useCallback((nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setAccountsExpanded(false)
    }
  }, [])

  useEffect(() => {
    if (accountsExpanded) {
      void fetchInactiveCodexAccountUsage()
    }
  }, [accountsExpanded, fetchInactiveCodexAccountUsage])

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
      includeFallbackWsl: shouldIncludeSettingsWslRuntime(settings)
    }
  )
  const selectedGroup =
    switchGroups.find((group) => group.key === selectedRuntimeKey) ?? switchGroups[0]
  const activeTarget = selectedGroup?.targets.find((target) => target.active)

  return (
    <ProviderDetailsMenu
      provider={codex}
      compact={compact}
      iconOnly={iconOnly}
      ariaLabel="Open Codex details and account switcher"
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={(group) => void handleSelectRuntime(group)}
          ariaLabel="Codex usage runtime"
        />
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenuLabel>Codex Account</DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          setAccountsExpanded((prev) => !prev)
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5 text-[12px]">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-foreground">
              {activeTarget?.label ?? 'System default'}
            </span>
          </div>
        </div>
        {accountsExpanded ? (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/85" />
        ) : (
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground/85" />
        )}
      </DropdownMenuItem>
      {accountsExpanded ? (
        <div className="px-1 pb-1">
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
            {selectedGroup ? (
              <>
                {selectedGroup.targets.map((target) => {
                  const inactiveUsage = target.id
                    ? inactiveCodexAccounts.find((a) => a.accountId === target.id)
                    : null
                  const showSignInAction =
                    !target.active &&
                    target.id !== null &&
                    isUnavailableInactiveUsage(inactiveUsage?.claude)
                  const isSigningIn = reauthenticatingAccountId === target.id
                  const isBusy = isSwitching || reauthenticatingAccountId !== null

                  return (
                    <DropdownMenuItem
                      key={`${selectedGroup.key}:${target.id ?? 'system'}`}
                      onSelect={(event) => {
                        // Why: account switching may need an immediate follow-up
                        // restart action for live Codex tabs. Prevent the menu from
                        // auto-closing so that prompt can stay within the same
                        // account-switcher interaction instead of jumping elsewhere.
                        event.preventDefault()
                        if (suppressNextAccountSelectRef.current) {
                          suppressNextAccountSelectRef.current = false
                          return
                        }
                        if (!target.active) {
                          void handleSelectAccount(target.id, target.runtimeTarget)
                        }
                      }}
                      disabled={isBusy || target.active}
                    >
                      <div className="flex w-full min-w-0 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{target.label}</span>
                          {target.active ? (
                            <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                              Active
                            </span>
                          ) : null}
                        </div>
                        {inactiveUsage?.isFetching && !inactiveUsage.claude ? (
                          <InlineUsageSkeleton />
                        ) : showSignInAction ? (
                          <InlineUsageSignInAction
                            isFetching={inactiveUsage?.isFetching ?? false}
                            isSigningIn={isSigningIn}
                            disabled={isBusy}
                            onSignInPointerDown={suppressNextAccountSelect}
                            onSignIn={() => {
                              suppressNextAccountSelect()
                              if (target.id !== null) {
                                void handleSignInAccount(target.id)
                              }
                            }}
                          />
                        ) : inactiveUsage?.claude ? (
                          <InlineUsageBars
                            limits={inactiveUsage.claude}
                            isFetching={inactiveUsage.isFetching}
                          />
                        ) : null}
                      </div>
                    </DropdownMenuItem>
                  )
                })}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {open ? <CodexRestartStatusPrompt /> : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-codex'
          })
          openSettingsPage()
        }}
      >
        Manage Accounts…
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}

function ProviderDetailsMenu({
  provider,
  compact,
  iconOnly,
  ariaLabel,
  topContent,
  open,
  onOpenChange,
  children
}: {
  provider: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  ariaLabel: string
  topContent?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      recordFeatureInteraction('usage-tracking')
    }
    onOpenChange?.(nextOpen)
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={ariaLabel}
        >
          {iconOnly ? (
            <span className="inline-flex items-center gap-1">
              <span
                className={`inline-block h-2 w-2 rounded-full ${provider.session || provider.weekly ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}`}
              />
              <span className="text-muted-foreground">
                {provider.provider === 'claude'
                  ? 'C'
                  : provider.provider === 'gemini'
                    ? 'G'
                    : provider.provider === 'opencode-go'
                      ? 'O'
                      : 'X'}
              </span>
            </span>
          ) : (
            <ProviderSegment p={provider} compact={compact} />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[260px]">
        {topContent}
        <div className="p-2">
          <ProviderPanel p={provider} />
        </div>
        {children ? (
          <>
            <DropdownMenuSeparator />
            {children}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

function StatusBarInner({ floatingTerminalOpen }: StatusBarProps): React.JSX.Element | null {
  const floatingTerminalShortcut = useShortcutLabel('floatingTerminal.toggle')
  const rateLimits = useAppStore((s) => s.rateLimits)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const statusBarItems = useAppStore((s) => s.statusBarItems)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const floatingTerminalEnabled = useAppStore((s) => s.settings?.floatingTerminalEnabled === true)
  const floatingTerminalTriggerLocation = useAppStore(
    (s) => s.settings?.floatingTerminalTriggerLocation ?? 'floating-button'
  )
  // Why: usage bars exist to surface CLI rate limits — showing one for an
  // agent that isn't on the user's PATH is just noise (e.g. a fresh Ubuntu
  // install showing "Gemini Usage" with no Gemini CLI installed). We gate
  // the per-CLI bars on detection so the surface stays self-pruning, and
  // re-show automatically once the agent appears on PATH.
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  // Why: pet segment intentionally does NOT participate in statusBarItems
  // (see design doc — gating with both the experimental flag and a
  // statusBarItems checkbox would double-toggle the surface). It is driven
  // purely by the experimentalPet settings flag.
  const petEnabled = useAppStore((s) => s.settings?.experimentalPet === true)
  const toggleStatusBarItem = useAppStore((s) => s.toggleStatusBarItem)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  const [containerWidth, setContainerWidth] = useState(900)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  // Why: trigger PATH-based agent detection on mount so the per-CLI usage
  // bars (Claude/Codex/Gemini) can hide themselves when the user doesn't
  // have those CLIs installed. The slice deduplicates concurrent callers,
  // so this is safe even if other surfaces also call it.
  useEffect(() => {
    void ensureDetectedAgents()
  }, [ensureDetectedAgents])

  const containerRefCallback = useCallback((node: HTMLDivElement | null) => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect()
      resizeObserverRef.current = null
    }
    if (node) {
      containerRef.current = node
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerWidth(entry.contentRect.width)
        }
      })
      observer.observe(node)
      resizeObserverRef.current = observer
      setContainerWidth(node.getBoundingClientRect().width)
    }
  }, [])

  const refreshDetectedAgents = useAppStore((s) => s.refreshDetectedAgents)
  const handleRefresh = useCallback(async () => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    try {
      // Why: also re-run PATH detection so a freshly-installed CLI's bar
      // appears (and a removed CLI's bar hides) without restarting Orca.
      await Promise.all([refreshRateLimits(), refreshDetectedAgents()])
    } finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing, refreshRateLimits, refreshDetectedAgents])

  if (!statusBarVisible) {
    return null
  }

  const { claude, codex, gemini, opencodeGo } = rateLimits

  // Why: hiding `unavailable` providers makes the status bar appear to lose a
  // provider at random after refreshes or wake/resume. Keeping the slot visible
  // preserves layout stability and makes it obvious that the provider is still
  // configured but currently unavailable. Detection-gating (see
  // status-bar-agent-gating) hides the per-CLI bars when the agent isn't
  // installed on PATH — this is what stops a fresh install from showing
  // "Gemini Usage" when Gemini isn't installed.
  const showClaude =
    !!claude &&
    statusBarItems.includes('claude') &&
    isStatusBarItemAvailable('claude', detectedAgentIds)
  const showCodex =
    !!codex &&
    statusBarItems.includes('codex') &&
    isStatusBarItemAvailable('codex', detectedAgentIds)
  // Why: hide only when the state hasn't loaded yet (null), not when unavailable.
  // Gemini shows if credentials exist; OpenCode Go shows always so users can see
  // the provider and know to configure the cookie in Settings.
  const showGemini =
    gemini !== null &&
    statusBarItems.includes('gemini') &&
    isStatusBarItemAvailable('gemini', detectedAgentIds)
  // Why: OpenCode Go is a web/cookie-auth provider, not a CLI on PATH, so
  // detection-gating doesn't apply.
  const showOpencodeGo = opencodeGo !== null && statusBarItems.includes('opencode-go')
  const showSsh = statusBarItems.includes('ssh')
  const showResourceUsage = statusBarItems.includes('resource-usage')
  const showPorts = statusBarItems.includes('ports')
  const showFloatingTerminalToggle =
    floatingTerminalEnabled && floatingTerminalTriggerLocation === 'status-bar'
  const anyVisible = showClaude || showCodex || showGemini || showOpencodeGo || showResourceUsage
  const anyFetching =
    claude?.status === 'fetching' ||
    codex?.status === 'fetching' ||
    gemini?.status === 'fetching' ||
    opencodeGo?.status === 'fetching'

  const compact = containerWidth < 900
  const iconOnly = containerWidth < 500
  const floatingTerminalActionLabel = floatingTerminalOpen
    ? 'Minimize Floating Workspace'
    : 'Show Floating Workspace'

  return (
    <div
      ref={containerRefCallback}
      className="flex items-center h-6 min-h-[24px] px-3 gap-4 border-t border-border bg-[var(--bg-titlebar,var(--card))] text-xs select-none shrink-0 relative"
      onContextMenuCapture={(event) => {
        if (!shouldOpenStatusBarContextMenu(event.target)) {
          return
        }
        // Why: mirror the right-click pattern used across the app
        // (WorktreeContextMenu, TerminalContextMenu, tab bar) — dispatch the
        // global close event so peer menus dismiss, then place a hidden
        // trigger at the cursor so the menu anchors there. This also lets a
        // second right-click reposition the menu instead of leaving it where
        // it first opened.
        event.preventDefault()
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpen(true)
      }}
    >
      <div className="flex items-center gap-3">
        {showClaude && <ClaudeSwitcherMenu claude={claude} compact={compact} iconOnly={iconOnly} />}
        {showCodex && <CodexSwitcherMenu codex={codex} compact={compact} iconOnly={iconOnly} />}
        {showGemini && (
          <ProviderDetailsMenu
            provider={gemini}
            compact={compact}
            iconOnly={iconOnly}
            ariaLabel="Open Gemini usage details"
          />
        )}
        {showOpencodeGo && (
          <ProviderDetailsMenu
            provider={opencodeGo}
            compact={compact}
            iconOnly={iconOnly}
            ariaLabel="Open OpenCode Go usage details"
          />
        )}
        {anyVisible && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                aria-label="Refresh rate limits"
              >
                <RefreshCw
                  size={11}
                  className={isRefreshing || anyFetching ? 'animate-spin' : ''}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              Refresh usage data
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3">
        <UpdateStatusSegment compact={compact} iconOnly={iconOnly} />
        {petEnabled && <PetStatusSegment />}
        {showResourceUsage && <ResourceUsageStatusSegment compact={compact} iconOnly={iconOnly} />}
        {showPorts && <PortsStatusSegment compact={compact} iconOnly={iconOnly} />}
        {showSsh && <SshStatusSegment compact={compact} iconOnly={iconOnly} />}
        {showFloatingTerminalToggle && (
          <FloatingTerminalIconContextMenu currentLocation="status-bar" className="relative">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex size-5 cursor-pointer items-center justify-center rounded border border-border bg-secondary text-secondary-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                  aria-label={floatingTerminalActionLabel}
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(TOGGLE_FLOATING_TERMINAL_EVENT))
                  }}
                >
                  <PanelsTopLeft className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {floatingTerminalActionLabel} ({floatingTerminalShortcut})
              </TooltipContent>
            </Tooltip>
          </FloatingTerminalIconContextMenu>
        )}
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-0 w-fit" sideOffset={0} align="start">
          {isStatusBarItemAvailable('claude', detectedAgentIds) && (
            <DropdownMenuCheckboxItem
              checked={statusBarItems.includes('claude')}
              onCheckedChange={() => {
                recordFeatureInteraction('usage-tracking')
                toggleStatusBarItem('claude')
              }}
            >
              <ClaudeIcon size={14} />
              Claude Usage
            </DropdownMenuCheckboxItem>
          )}
          {isStatusBarItemAvailable('codex', detectedAgentIds) && (
            <DropdownMenuCheckboxItem
              checked={statusBarItems.includes('codex')}
              onCheckedChange={() => {
                recordFeatureInteraction('usage-tracking')
                toggleStatusBarItem('codex')
              }}
            >
              <OpenAIIcon size={14} />
              Codex Usage
            </DropdownMenuCheckboxItem>
          )}
          {isStatusBarItemAvailable('gemini', detectedAgentIds) && (
            <DropdownMenuCheckboxItem
              checked={statusBarItems.includes('gemini')}
              onCheckedChange={() => {
                recordFeatureInteraction('usage-tracking')
                toggleStatusBarItem('gemini')
              }}
            >
              <GeminiIcon size={14} />
              Gemini Usage
            </DropdownMenuCheckboxItem>
          )}
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('opencode-go')}
            onCheckedChange={() => {
              recordFeatureInteraction('usage-tracking')
              toggleStatusBarItem('opencode-go')
            }}
          >
            <OpenCodeGoIcon size={14} />
            OpenCode Go Usage
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('ssh')}
            onCheckedChange={() => {
              recordFeatureInteraction('ssh')
              toggleStatusBarItem('ssh')
            }}
          >
            <Server className="size-3.5" />
            SSH Status
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('resource-usage')}
            onCheckedChange={() => {
              recordFeatureInteraction('resource-manager')
              toggleStatusBarItem('resource-usage')
            }}
          >
            <Activity className="size-3.5" />
            Resource Manager
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('ports')}
            onCheckedChange={() => {
              recordFeatureInteraction('ports')
              toggleStatusBarItem('ports')
            }}
          >
            <Plug className="size-3.5" />
            Ports
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const StatusBar = React.memo(StatusBarInner)

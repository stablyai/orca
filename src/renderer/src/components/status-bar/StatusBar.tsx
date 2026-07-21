/* eslint-disable max-lines -- keeps provider rendering, menus, and compact-layout together for consistent Claude/Codex hover/click states. */
import {
  AlertTriangle,
  Activity,
  RotateCcw,
  Plug,
  ChevronDown,
  ChevronRight,
  Loader2,
  PanelsTopLeft,
  RefreshCw,
  Server
} from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import { selectFloatingWorkspaceHasUnread } from '../../store/selectors'
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
import { resolveLocalAccountRuntimeTarget } from '../../../../shared/local-account-runtime'
import { getRendererAppPlatform } from '../../lib/renderer-app-platform'
import {
  ProviderIcon,
  ProviderPanel,
  barColor,
  clampUsedPercent,
  formatResetCreditExpiry,
  getProviderDisplayName,
  getProviderUsageStatusLabel
} from './tooltip'
import { ClaudeIcon, GeminiIcon, MiniMaxIcon, OpenAIIcon, OpenCodeGoIcon } from './icons'
import { AgentIcon } from '@/lib/agent-catalog'
import { UsageRosterPanel, getTightestUsageSection } from './UsageRosterPanel'
import { getUsageProviderAccountsSectionId } from './usage-provider-settings-target'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { markLiveCodexSessionsForRestart } from '@/lib/codex-session-restart'
import { UpdateStatusSegment } from './UpdateStatusSegment'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import { getVisibleUsageProvider, isUsageEmptyState } from './status-bar-provider-visibility'
import { StatusBarUsageEmptyCta } from './StatusBarUsageEmptyCta'
import { UsagePercentageDisplayChangeNotice } from './UsagePercentageDisplayChangeNotice'
import {
  STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS,
  shouldOpenStatusBarContextMenu
} from './status-bar-context-menu-policy'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { FloatingTerminalIconContextMenu } from '@/components/floating-terminal/FloatingTerminalIconContextMenu'
import { summarizeCodexRestartStatus } from './codex-restart-status-summary'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  fetchProviderAccountsSnapshot,
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from '@/runtime/runtime-provider-accounts-client'
import { translate } from '@/i18n/i18n'
import {
  getDisplayedUsagePercentage,
  normalizeUsagePercentageDisplay,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import {
  normalizeStatusBarUsageMode,
  type StatusBarUsageMode
} from '../../../../shared/status-bar-usage-mode'

type StatusBarProps = {
  floatingTerminalOpen: boolean
}

const PetStatusSegment = lazyWithRetry(() =>
  import('./PetStatusSegment').then((module) => ({ default: module.PetStatusSegment }))
)
const ResourceUsageStatusSegment = lazyWithRetry(() =>
  import('./ResourceUsageStatusSegment').then((module) => ({
    default: module.ResourceUsageStatusSegment
  }))
)
const PortsStatusSegment = lazyWithRetry(() =>
  import('./PortsStatusSegment').then((module) => ({ default: module.PortsStatusSegment }))
)
const SshStatusSegment = lazyWithRetry(() =>
  import('./SshStatusSegment').then((module) => ({ default: module.SshStatusSegment }))
)

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
  hostLabel?: string
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

function getCodexStatusRuntimeLabel(
  target: CodexStatusRuntimeTarget,
  hostLabel = getHostRuntimeLabel()
): string {
  if (target.runtime === 'host') {
    return hostLabel
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

export function getStatusBarPreferredWslDistro(
  settings: GlobalSettings | null | undefined,
  wslDistros: string[],
  platform: NodeJS.Platform = getRendererAppPlatform()
): string | null {
  if (settings) {
    const target = resolveLocalAccountRuntimeTarget(settings, platform)
    if (target.runtime === 'wsl' && target.wslDistro) {
      return target.wslDistro
    }
  }
  return wslDistros.length === 1 ? wslDistros[0] : null
}

function shouldIncludeSettingsWslRuntime(settings: GlobalSettings | null | undefined): boolean {
  if (!settings) {
    return false
  }
  // Why: the fallback group must match the concrete runtime used for account polling.
  return resolveLocalAccountRuntimeTarget(settings, getRendererAppPlatform()).runtime === 'wsl'
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
      label: getCodexStatusRuntimeLabel(target, options.hostLabel),
      runtimeTarget: target,
      targets: [
        {
          id: null,
          label: translate('auto.components.status.bar.StatusBar.c676918adc', 'System default'),
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
      label: getCodexStatusRuntimeLabel(target, options.hostLabel),
      runtimeTarget: target,
      targets: [
        {
          id: null,
          label: translate('auto.components.status.bar.StatusBar.c676918adc', 'System default'),
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

// Why: with a Remote Orca Server, local GlobalSettings describe this desktop, not the owner — the server snapshot wins (#7973).
export function resolveCodexStatusAccountState(
  settings: GlobalSettings | null | undefined,
  runtimeState: CodexRateLimitAccountsState
): CodexRateLimitAccountsState {
  if (settings?.activeRuntimeEnvironmentId?.trim()) {
    return runtimeState
  }
  return getCodexStatusAccountsFromSettings(settings) ?? runtimeState
}

export function resolveClaudeStatusAccountState(
  settings: GlobalSettings | null | undefined,
  runtimeState: ClaudeRateLimitAccountsState
): ClaudeRateLimitAccountsState {
  if (settings?.activeRuntimeEnvironmentId?.trim()) {
    return runtimeState
  }
  return getClaudeStatusAccountsFromSettings(settings) ?? runtimeState
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
          {/* Why: notices are per-PTY-session but restart is per-pane; show both counts so split panes don't look wrong. */}
          {staleCodexStatus.staleSessionCount === 1
            ? translate(
                'auto.components.status.bar.StatusBar.605901a495',
                '1 Codex session is still on the old account'
              )
            : translate(
                'auto.components.status.bar.StatusBar.1446d0d8a0',
                '{{value0}} Codex sessions are still on the old account.',
                { value0: staleCodexStatus.staleSessionCount }
              )}
          {staleCodexStatus.staleWorktreeCount > 1 ? (
            <span className="mt-0.5 block">
              {translate(
                'auto.components.status.bar.StatusBar.59c6e7b4e0',
                'Visible sessions restart now. Others restart when their worktree becomes active.'
              )}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => queueCodexPaneRestarts(staleCodexStatus.stalePtyIds)}
          className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
        >
          {staleCodexStatus.staleSessionCount === 1
            ? translate('auto.components.status.bar.StatusBar.6cd6650b4c', 'Restart Session')
            : translate(
                'auto.components.status.bar.StatusBar.cd9d7b40ff',
                'Restart {{value0}} Sessions',
                { value0: staleCodexStatus.staleSessionCount }
              )}
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

function MiniBar({
  usedPct,
  display
}: {
  usedPct: number
  display: UsagePercentageDisplay
}): React.JSX.Element {
  return (
    <div className="w-[48px] h-[6px] rounded-full bg-muted overflow-hidden flex-shrink-0">
      <div
        className="h-full rounded-full transition-all duration-300 bg-muted-foreground/40"
        style={{ width: `${getDisplayedUsagePercentage(usedPct, display)}%` }}
      />
    </div>
  )
}

// Compact usage bars for inactive accounts in the switcher.
export function InlineUsageBars({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits
  isFetching: boolean
}): React.JSX.Element {
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  // Why: tick the session countdown live via one boundary-scheduled clock, not just the usage poll (#5399).
  const now = useResetCountdownClock([limits.session?.resetsAt])
  const usageWindows = [
    limits.session
      ? {
          key: 'session',
          used: clampUsedPercent(limits.session.usedPercent),
          // Why: live reset countdown (matches popover); '5h' window length only when resetsAt is unknown (#5399).
          label: formatRateLimitWindowChipLabel(limits.session, now)
        }
      : null,
    limits.weekly
      ? {
          key: 'weekly',
          used: clampUsedPercent(limits.weekly.usedPercent),
          label: translate('auto.components.status.bar.StatusBar.5c938d39ac', 'wk')
        }
      : null,
    limits.fableWeekly
      ? {
          key: 'fableWeekly',
          used: clampUsedPercent(limits.fableWeekly.usedPercent),
          label: translate('auto.components.status.bar.StatusBar.54e8d6bb2d', 'Fable')
        }
      : null
  ].filter((window): window is { key: string; used: number; label: string } => window !== null)

  return (
    <div
      className={`grid w-full items-center gap-1.5 ${isFetching ? 'animate-pulse' : ''}`}
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, usageWindows.length)}, minmax(0, 1fr))`
      }}
    >
      {usageWindows.map((window) => (
        <div key={window.key} className="flex min-w-0 items-center gap-1">
          <div className="h-[4px] min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            {/* Why: fill follows the selected percentage; color still signals consumption urgency. */}
            <div
              className={`h-full rounded-full ${barColor(window.used)}`}
              style={{ width: `${getDisplayedUsagePercentage(window.used, display)}%` }}
            />
          </div>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatUsagePercentageLabel(window.used, display)} {window.label}
          </span>
        </div>
      ))}
      {usageWindows.length === 0 && limits.status === 'error' ? (
        <span className="text-[10px] text-muted-foreground">
          {translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')}
        </span>
      ) : null}
    </div>
  )
}

function isUnavailableInactiveUsage(limits: ProviderRateLimits | null | undefined): boolean {
  return limits?.status === 'error' && !limits.session && !limits.weekly && !limits.fableWeekly
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
      <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
        {translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')}
      </span>
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
        {translate('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}
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

function WindowLabel({
  w,
  label,
  display,
  showLabel = true
}: {
  w: RateLimitWindow
  label: string
  display: UsagePercentageDisplay
  showLabel?: boolean
}): React.JSX.Element {
  return (
    <span className="tabular-nums">
      {formatUsagePercentageLabel(w.usedPercent, display)}
      {showLabel ? ` ${label}` : ''}
    </span>
  )
}

// Single-letter provider badge for the icon-only (narrow) status bar. Shared by
// the roster trigger and ProviderDetailsMenu so the dot's has-data condition
// and markup can't drift between the two.
function ProviderLetterBadge({ p }: { p: ProviderRateLimits }): React.JSX.Element {
  const hasData = Boolean(p.session || p.weekly || p.fableWeekly || p.monthly || p.buckets?.length)
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span
        className={`inline-block h-2 w-2 rounded-full ${hasData ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}`}
      />
      {getProviderLetter(p.provider)}
    </span>
  )
}

function getProviderLetter(provider: ProviderRateLimits['provider']): string {
  switch (provider) {
    case 'claude':
      return 'C'
    case 'gemini':
      return 'G'
    case 'opencode-go':
      return 'O'
    case 'kimi':
      return 'K'
    case 'antigravity':
      return 'A'
    case 'minimax':
      return 'M'
    case 'grok':
      return 'R'
    case 'codex':
      return 'X'
  }
}

// ---------------------------------------------------------------------------
// Provider segment
// ---------------------------------------------------------------------------

// Why: Gemini exposes extra experimental buckets that made the pre-existing verbose footer noisy.
const STATUS_BAR_BUCKET_NAMES = new Set(['Flash', 'Pro', '1.5 Pro'])

function VerboseProviderUsage({
  p,
  compact,
  display
}: {
  p: ProviderRateLimits
  compact: boolean
  display: UsagePercentageDisplay
}): React.JSX.Element {
  if (p.buckets && p.buckets.length > 0) {
    const visibleBuckets = p.buckets.filter((bucket) => STATUS_BAR_BUCKET_NAMES.has(bucket.name))
    return (
      <>
        {visibleBuckets.map((bucket, index) => (
          <React.Fragment key={bucket.name}>
            {index > 0 ? <span className="text-muted-foreground">·</span> : null}
            <span className="tabular-nums">
              {bucket.name} {formatUsagePercentageLabel(bucket.usedPercent, display)}
            </span>
          </React.Fragment>
        ))}
        {visibleBuckets.length === 0 && p.session ? (
          <WindowLabel
            w={p.session}
            label={formatRateLimitWindowChipLabel(p.session)}
            display={display}
          />
        ) : null}
      </>
    )
  }

  const visibleWindows = [
    p.session
      ? {
          key: 'session',
          window: p.session,
          label: formatRateLimitWindowChipLabel(p.session)
        }
      : null,
    p.weekly
      ? {
          key: 'weekly',
          window: p.weekly,
          label: formatRateLimitWindowChipLabel(p.weekly)
        }
      : null,
    p.fableWeekly
      ? {
          key: 'fableWeekly',
          window: p.fableWeekly,
          label: translate('auto.components.status.bar.StatusBar.a79c64f87e', 'Fable')
        }
      : null,
    // Why: monthly stays inline for monthly-only providers; otherwise the detail panel carries it.
    p.monthly && !p.session && !p.weekly
      ? {
          key: 'monthly',
          window: p.monthly,
          label: formatRateLimitWindowChipLabel(p.monthly)
        }
      : null
  ].filter((window): window is { key: string; window: RateLimitWindow; label: string } => {
    return window !== null
  })

  return (
    <>
      {p.session && !compact ? (
        <MiniBar usedPct={clampUsedPercent(p.session.usedPercent)} display={display} />
      ) : null}
      {visibleWindows.map((window, index) => (
        <React.Fragment key={window.key}>
          {index > 0 ? <span className="text-muted-foreground">·</span> : null}
          <WindowLabel w={window.window} label={window.label} display={display} />
        </React.Fragment>
      ))}
    </>
  )
}

export function ProviderSegment({
  p,
  compact,
  display,
  mode = 'verbose'
}: {
  p: ProviderRateLimits | null
  compact: boolean
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
}): React.JSX.Element {
  const provider = p?.provider ?? 'claude'
  const statusLabel = p ? getProviderUsageStatusLabel(p) : ''

  // Idle / initial load
  if (!p || p.status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  const tightest = getTightestUsageSection(p)

  // Fetching with no prior data
  if (p.status === 'fetching' && !tightest) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">···</span>
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
  if (p.status === 'error' && !tightest) {
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

  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {mode === 'verbose' ? (
        <VerboseProviderUsage p={p} compact={compact} display={display} />
      ) : (
        <>
          {tightest && !compact ? (
            <MiniBar usedPct={clampUsedPercent(tightest.window.usedPercent)} display={display} />
          ) : null}
          {tightest ? (
            <WindowLabel
              w={tightest.window}
              label={tightest.label}
              display={display}
              showLabel={!compact}
            />
          ) : null}
        </>
      )}
      {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
    </span>
  )
}

export function CodexSwitcherMenu({
  codex,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  codex: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
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
  const codexAccountSyncKey = useAppStore((s) => {
    const settings = s.settings
    if (!settings) {
      return 'no-settings'
    }
    return `${settings.activeRuntimeEnvironmentId?.trim() || 'local'}:${settings.activeCodexManagedAccountId ?? 'system'}:${JSON.stringify(settings.activeCodexManagedAccountIdsByRuntime ?? null)}:${settings.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  })
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
          previousAccountLabel: getCodexAccountLabel(accountState, previousActiveAccountId),
          nextAccountLabel: getCodexAccountLabel(next, nextActiveAccountId)
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

  const handleSignInAccount = async (accountId: string): Promise<void> => {
    if (isSwitching || reauthenticatingAccountId !== null) {
      return
    }
    setReauthenticatingAccountId(accountId)
    try {
      const next = await window.api.codexAccounts.reauthenticate({ accountId })
      recordFeatureInteraction('codex-account-switching')
      if (mountedRef.current) {
        setAccounts(next)
      }
      await fetchSettings()
      if (mountedRef.current && accountsExpandedRef.current) {
        await fetchInactiveCodexAccountUsage()
      }
    } catch (error) {
      console.error('Failed to re-authenticate Codex account from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setReauthenticatingAccountId(null)
      }
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
  const resetCreditCount = codex.rateLimitResetCredits?.availableCount ?? null
  const resetCreditExpiry =
    resetCreditCount !== null
      ? formatResetCreditExpiry(codex.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null
  // Why: reset credits redeem against the desktop's own Codex login, not a remote account owner's.
  const canRedeemReset =
    !hasActiveRuntimeEnvironment && resetCreditCount !== null && resetCreditCount > 0

  return (
    <ProviderDetailsMenu
      provider={codex}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      // Why: Codex reset credits render beside the reset action below; showing
      // them in the generic provider summary duplicates the same metadata.
      hidePanelResetCredits
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.ba55303942',
        'Open Codex details and account switcher'
      )}
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={(group) => void handleSelectRuntime(group)}
          ariaLabel={translate(
            'auto.components.status.bar.StatusBar.38b5647724',
            'Codex usage runtime'
          )}
        />
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.status.bar.StatusBar.972a1ff497', 'Reset Codex limits?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.status.bar.StatusBar.6d1042aa6f',
                'This uses one Codex rate-limit reset credit for the active account and resets any eligible usage windows immediately.'
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground">
            <Checkbox
              checked={skipFutureResetConfirm}
              onCheckedChange={(checked) => setSkipFutureResetConfirm(checked === true)}
            />
            <span>
              {translate('auto.components.status.bar.StatusBar.f077f586db', "Don't ask again")}
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirmOpen(false)}>
              {translate('auto.components.status.bar.StatusBar.c0e972d726', 'Cancel')}
            </Button>
            <Button onClick={() => void handleConfirmReset()} disabled={isRedeemingReset}>
              {isRedeemingReset ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {isRedeemingReset
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {resetCreditCount !== null ? (
        <>
          <DropdownMenuLabel className="space-y-0.5">
            <div>
              {resetCreditCount === 1
                ? translate(
                    'auto.components.status.bar.StatusBar.5e5f9f5160',
                    '1 rate-limit reset available'
                  )
                : translate(
                    'auto.components.status.bar.StatusBar.5ecae9197c',
                    '{{value0}} rate-limit resets available',
                    { value0: resetCreditCount }
                  )}
            </div>
            {resetCreditExpiry ? (
              <div className="text-[11px] font-normal text-muted-foreground">
                {resetCreditExpiry}
              </div>
            ) : null}
          </DropdownMenuLabel>
          {canRedeemReset ? (
            <DropdownMenuItem
              disabled={isRedeemingReset}
              onSelect={(event) => {
                event.preventDefault()
                handleResetMenuSelect()
              }}
            >
              {isRedeemingReset ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : null}
              {isRedeemingReset
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuLabel>
        {translate('auto.components.status.bar.StatusBar.7657e3db9c', 'Codex Account')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          handleAccountsExpandedToggle()
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5 text-[12px]">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-foreground">
              {activeTarget?.label ??
                translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')}
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
                  // Why: sign-in spawns a local `codex login`, so a remote-owned account can't be re-authed from this desktop.
                  const showSignInAction =
                    !hasActiveRuntimeEnvironment &&
                    !target.active &&
                    target.id !== null &&
                    isUnavailableInactiveUsage(inactiveUsage?.rateLimits)
                  const isSigningIn = reauthenticatingAccountId === target.id
                  const isBusy = isSwitching || reauthenticatingAccountId !== null

                  return (
                    <DropdownMenuItem
                      key={`${selectedGroup.key}:${target.id ?? 'system'}`}
                      onSelect={(event) => {
                        // Why: keep the menu open so the follow-up "restart live Codex tabs" prompt stays in this interaction.
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
                              {translate(
                                'auto.components.status.bar.StatusBar.ff0fbe9311',
                                'Active'
                              )}
                            </span>
                          ) : null}
                        </div>
                        {inactiveUsage?.isFetching && !inactiveUsage.rateLimits ? (
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
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}

export function ProviderDetailsMenu({
  provider,
  compact,
  iconOnly,
  ariaLabel,
  topContent,
  hidePanelResetCredits = false,
  open,
  onOpenChange,
  children,
  asSubmenu = false,
  triggerContent
}: {
  provider: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  ariaLabel: string
  topContent?: React.ReactNode
  hidePanelResetCredits?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
  // When set, render as a drill-in submenu (used by the consolidated Usage
  // popover) with triggerContent as the full-width row instead of a segment.
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const usagePercentageDisplay = normalizeUsagePercentageDisplay(
    useAppStore((s) => s.usagePercentageDisplay)
  )
  const menuFocusHandoff = useStatusBarMenuFocusHandoff()

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      menuFocusHandoff.reset()
      recordFeatureInteraction('usage-tracking')
    }
    onOpenChange?.(nextOpen)
  }

  const panelBody = (
    <>
      {topContent}
      <div className="p-2">
        {/* Why: provider-specific action sections may render richer reset-credit UI. */}
        <ProviderPanel
          p={provider}
          showResetCredits={!hidePanelResetCredits}
          usagePercentageDisplay={usagePercentageDisplay}
        />
      </div>
      {children ? (
        <>
          <DropdownMenuSeparator />
          {children}
        </>
      ) : null}
    </>
  )

  if (asSubmenu) {
    return (
      <DropdownMenuSub open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuSubTrigger className="w-full items-center gap-3 px-3.5 py-2.5">
          {triggerContent}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          collisionPadding={{ top: 8, bottom: 32, left: 8, right: 8 }}
          className="max-h-(--radix-dropdown-menu-content-available-height) w-[300px] overflow-y-auto p-0 scrollbar-sleek"
        >
          {panelBody}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={ariaLabel}
        >
          {iconOnly ? (
            <ProviderLetterBadge p={provider} />
          ) : (
            <ProviderSegment p={provider} compact={compact} display={usagePercentageDisplay} />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="start"
        sideOffset={8}
        className="w-[260px]"
        onPointerDownOutside={menuFocusHandoff.onPointerDownOutside}
        onCloseAutoFocus={menuFocusHandoff.onCloseAutoFocus}
      >
        {panelBody}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

function useStatusBarMenuFocusHandoff(): {
  reset: () => void
  onPointerDownOutside: () => void
  onCloseAutoFocus: (event: Event) => void
} {
  const skipCloseAutoFocusRef = useRef(false)
  return {
    reset: () => {
      skipCloseAutoFocusRef.current = false
    },
    onPointerDownOutside: () => {
      skipCloseAutoFocusRef.current = true
    },
    onCloseAutoFocus: (event) => {
      if (!skipCloseAutoFocusRef.current) {
        return
      }
      skipCloseAutoFocusRef.current = false
      // Why: Radix trigger restoration steals the first click from surfaces such as xterm.
      event.preventDefault()
    }
  }
}

function StatusBarInner({ floatingTerminalOpen }: StatusBarProps): React.JSX.Element | null {
  const floatingTerminalShortcut = useShortcutLabel('floatingTerminal.toggle')
  const rateLimits = useAppStore((s) => s.rateLimits)
  const settings = useAppStore((s) => s.settings)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const usagePercentageDisplay = normalizeUsagePercentageDisplay(
    useAppStore((s) => s.usagePercentageDisplay)
  )
  const statusBarUsageMode = normalizeStatusBarUsageMode(useAppStore((s) => s.statusBarUsageMode))
  const setStatusBarUsageMode = useAppStore((s) => s.setStatusBarUsageMode)
  const [usageMenuOpen, setUsageMenuOpen] = useState(false)
  const usageMenuFocusHandoff = useStatusBarMenuFocusHandoff()
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const statusBarItems = useAppStore((s) => s.statusBarItems)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  // Why: reuse the floating-button's unread dot so activity shows for either trigger location (see FloatingTerminalToggleButton).
  const hasFloatingUnread = useAppStore(selectFloatingWorkspaceHasUnread)
  const floatingTerminalEnabled = settings?.floatingTerminalEnabled === true
  const floatingTerminalTriggerLocation =
    settings?.floatingTerminalTriggerLocation ?? 'floating-button'
  // Why: gate per-CLI bars on PATH detection so an uninstalled agent isn't shown a noisy empty bar (auto re-shows when installed).
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  // Why: pet segment is driven purely by experimentalPet, not statusBarItems, to avoid double-toggling the surface (see design doc).
  const petEnabled = useAppStore((s) => s.settings?.experimentalPet === true)
  const toggleStatusBarItem = useAppStore((s) => s.toggleStatusBarItem)
  const usageEmptyStateDismissed = useAppStore((s) => s.usageEmptyStateDismissed)
  const containerRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  const [containerWidth, setContainerWidth] = useState(900)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  // Why: detect agents on mount so per-CLI usage bars hide when the CLI isn't installed; the slice dedupes concurrent callers.
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
      // Why: re-run PATH detection so a freshly-installed/removed CLI's bar appears/hides without restarting Orca.
      await Promise.all([refreshRateLimits(), refreshDetectedAgents()])
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false)
      }
    }
  }, [isRefreshing, refreshRateLimits, refreshDetectedAgents])

  if (!statusBarVisible) {
    return null
  }

  const { claude, codex, gemini, opencodeGo, kimi, antigravity, minimax, grok } = rateLimits

  // Why: a bar is earned by a live snapshot or durable Settings setup; detection-gating hides per-CLI bars when the agent isn't on PATH.
  // Why: Antigravity has no persisted credential, so a checked status item + detected CLI is the durable "show its slot" signal.
  // Why: Antigravity visibility also requires geminiCliOAuthEnabled because its usage snapshot mirrors the Gemini fetch.
  const antigravityUsageConfigured =
    statusBarItems.includes('antigravity') &&
    isStatusBarItemAvailable('antigravity', detectedAgentIds)
  // Why: thread non-GlobalSettings durability flags so bars stay visible across reloads and snapshot refreshes.
  const usageSettings = {
    ...settings,
    antigravityUsageConfigured,
    minimaxCookieConfigured: rateLimits.minimaxCookieConfigured,
    grokAuthConfigured: rateLimits.grokAuthConfigured
  }
  const visibleClaude = getVisibleUsageProvider('claude', claude, usageSettings)
  const visibleCodex = getVisibleUsageProvider('codex', codex, usageSettings)
  const visibleGemini = getVisibleUsageProvider('gemini', gemini, usageSettings)
  const visibleKimi = getVisibleUsageProvider('kimi', kimi, usageSettings)
  const visibleAntigravity = getVisibleUsageProvider('antigravity', antigravity, usageSettings)
  const visibleMiniMax = getVisibleUsageProvider('minimax', minimax, usageSettings)
  const visibleGrok = getVisibleUsageProvider('grok', grok, usageSettings)
  const showClaude =
    visibleClaude !== null &&
    statusBarItems.includes('claude') &&
    isStatusBarItemAvailable('claude', detectedAgentIds)
  const showCodex =
    visibleCodex !== null &&
    statusBarItems.includes('codex') &&
    isStatusBarItemAvailable('codex', detectedAgentIds)
  const showGemini =
    visibleGemini !== null &&
    statusBarItems.includes('gemini') &&
    isStatusBarItemAvailable('gemini', detectedAgentIds)
  const showKimi =
    visibleKimi !== null &&
    statusBarItems.includes('kimi') &&
    isStatusBarItemAvailable('kimi', detectedAgentIds)
  const showAntigravity =
    visibleAntigravity !== null &&
    statusBarItems.includes('antigravity') &&
    isStatusBarItemAvailable('antigravity', detectedAgentIds)
  // Why: MiniMax is cookie-auth, not a CLI on PATH, so detection-gating doesn't apply.
  const showMiniMax = visibleMiniMax !== null && statusBarItems.includes('minimax')
  const showGrok =
    visibleGrok !== null &&
    statusBarItems.includes('grok') &&
    isStatusBarItemAvailable('grok', detectedAgentIds)
  // Why: OpenCode Go is web/cookie-auth, not a CLI on PATH, so detection-gating doesn't apply.
  const visibleOpencodeGo = getVisibleUsageProvider('opencode-go', opencodeGo, usageSettings)
  const showOpencodeGo = visibleOpencodeGo !== null && statusBarItems.includes('opencode-go')
  const showSsh = statusBarItems.includes('ssh')
  const showResourceUsage = statusBarItems.includes('resource-usage')
  const showPorts = statusBarItems.includes('ports')
  const showFloatingTerminalToggle =
    floatingTerminalEnabled && floatingTerminalTriggerLocation === 'status-bar'
  // Why: meter-only children (excludes resource-usage) so the % display callout anchors to a real meter cluster.
  const hasVisibleUsageMeters =
    showClaude ||
    showCodex ||
    showGemini ||
    showOpencodeGo ||
    showKimi ||
    showAntigravity ||
    showMiniMax ||
    showGrok
  const anyVisible = hasVisibleUsageMeters || showResourceUsage
  // Why: include Settings so durable managed accounts count — a configured user isn't shown the empty state while snapshots hydrate.
  const isEmptyUsageState = isUsageEmptyState(
    { claude, codex, gemini, opencodeGo, kimi, antigravity, minimax, grok },
    usageSettings
  )
  // Why: one-time nudge — once dismissed, stays hidden even if providers reconnect later.
  const showEmptyUsageCta = isEmptyUsageState && !usageEmptyStateDismissed
  const anyFetching =
    claude?.status === 'fetching' ||
    codex?.status === 'fetching' ||
    gemini?.status === 'fetching' ||
    opencodeGo?.status === 'fetching' ||
    kimi?.status === 'fetching' ||
    antigravity?.status === 'fetching' ||
    minimax?.status === 'fetching' ||
    grok?.status === 'fetching'

  const compact = containerWidth < 900
  const iconOnly = containerWidth < 500
  const floatingTerminalActionLabel = floatingTerminalOpen
    ? 'Minimize Floating Workspace'
    : 'Show Floating Workspace'
  const showFloatingWorkspaceAttentionDot = !floatingTerminalOpen && hasFloatingUnread

  // Why: the roster must contain only status items the user left visible;
  // otherwise an empty trigger would bypass those visibility controls.
  const rosterProviders = [
    showClaude ? visibleClaude : null,
    showCodex ? visibleCodex : null,
    showGemini ? visibleGemini : null,
    showAntigravity ? visibleAntigravity : null,
    showOpencodeGo ? visibleOpencodeGo : null,
    showKimi ? visibleKimi : null,
    showMiniMax ? visibleMiniMax : null,
    showGrok ? visibleGrok : null
  ].filter((p): p is ProviderRateLimits => p !== null)

  const handleManageAccounts = (): void => {
    setUsageMenuOpen(false)
    openSettingsTarget({ pane: 'accounts', repoId: null })
    openSettingsPage()
  }
  const handleUsageDetails = (): void => {
    setUsageMenuOpen(false)
    openSettingsTarget({ pane: 'stats', repoId: null })
    openSettingsPage()
  }
  const handleOpenProviderAccounts = (provider: ProviderRateLimits['provider']): void => {
    const sectionId = getUsageProviderAccountsSectionId(provider)
    if (!sectionId) {
      return
    }
    setUsageMenuOpen(false)
    openSettingsTarget({ pane: 'accounts', repoId: null, sectionId })
    openSettingsPage()
  }
  const handleUsageMenuOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      usageMenuFocusHandoff.reset()
      recordFeatureInteraction('usage-tracking')
    }
    setUsageMenuOpen(nextOpen)
  }

  return (
    <div
      ref={containerRefCallback}
      className="flex items-center h-6 min-h-[24px] px-3 gap-4 border-t border-border bg-[var(--bg-titlebar,var(--card))] text-xs select-none shrink-0 relative"
      onContextMenuCapture={(event) => {
        if (!shouldOpenStatusBarContextMenu(event.target)) {
          return
        }
        // Why: mirror the app-wide right-click pattern — close peer menus, then anchor a hidden trigger at the cursor so re-clicks reposition.
        event.preventDefault()
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpen(true)
      }}
    >
      <div className="flex items-center gap-3">
        {isEmptyUsageState ? (
          showEmptyUsageCta ? (
            <StatusBarUsageEmptyCta />
          ) : null
        ) : hasVisibleUsageMeters ? (
          // Consolidated roster pill → opens the all-agents Usage popover (mock parity).
          <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters={hasVisibleUsageMeters}>
            <DropdownMenu
              open={usageMenuOpen}
              onOpenChange={handleUsageMenuOpenChange}
              modal={false}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-3 rounded px-1 py-0.5 hover:bg-accent/70"
                  aria-label={translate(
                    'auto.components.status.bar.UsageRosterPanel.title',
                    'Usage'
                  )}
                >
                  {rosterProviders.map((p) =>
                    iconOnly ? (
                      // Narrow status bar: fall back to main's compact letter badge.
                      <span key={p.provider} title={getProviderDisplayName(p.provider)}>
                        <ProviderLetterBadge p={p} />
                      </span>
                    ) : (
                      <ProviderSegment
                        key={p.provider}
                        p={p}
                        compact={compact}
                        display={usagePercentageDisplay}
                        mode={statusBarUsageMode}
                      />
                    )
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
                side="top"
                align="start"
                sideOffset={8}
                // Keep the popover (and its drill-in submenus) above the status
                // bar instead of overlapping it — bottom padding ≈ footer height.
                collisionPadding={{ top: 8, bottom: 32, left: 8, right: 8 }}
                className="w-[360px] p-0"
                onPointerDownOutside={usageMenuFocusHandoff.onPointerDownOutside}
                onCloseAutoFocus={usageMenuFocusHandoff.onCloseAutoFocus}
              >
                <UsageRosterPanel
                  providers={rosterProviders}
                  display={usagePercentageDisplay}
                  statusBarUsageMode={statusBarUsageMode}
                  onStatusBarUsageModeChange={setStatusBarUsageMode}
                  isRefreshing={isRefreshing || anyFetching}
                  onRefresh={handleRefresh}
                  onOpenProvider={handleOpenProviderAccounts}
                  onSignIn={handleOpenProviderAccounts}
                  canSignIn={(provider) => getUsageProviderAccountsSectionId(provider) !== null}
                  onManageAccounts={handleManageAccounts}
                  onUsageDetails={handleUsageDetails}
                  renderRow={(p, rowNode) => {
                    // Every provider drills into its detail panel (parity with the
                    // per-provider dropdowns on main); Claude/Codex additionally get
                    // the account switcher + runtime toggle + Codex reset credits.
                    if (p.provider === 'claude') {
                      return (
                        <ClaudeSwitcherMenu
                          claude={p}
                          compact={compact}
                          iconOnly={false}
                          asSubmenu
                          triggerContent={rowNode}
                        />
                      )
                    }
                    if (p.provider === 'codex') {
                      return (
                        <CodexSwitcherMenu
                          codex={p}
                          compact={compact}
                          iconOnly={false}
                          asSubmenu
                          triggerContent={rowNode}
                        />
                      )
                    }
                    return (
                      <ProviderDetailsMenu
                        provider={p}
                        compact={compact}
                        iconOnly={false}
                        asSubmenu
                        triggerContent={rowNode}
                        ariaLabel={translate(
                          'auto.components.status.bar.UsageRosterPanel.openDetails',
                          'Open usage details'
                        )}
                      />
                    )
                  }}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </UsagePercentageDisplayChangeNotice>
        ) : null}
        {anyVisible && !isEmptyUsageState && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                aria-label={translate(
                  'auto.components.status.bar.StatusBar.3325d996cb',
                  'Refresh rate limits'
                )}
              >
                <RefreshCw
                  size={11}
                  className={isRefreshing || anyFetching ? 'animate-spin' : ''}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {translate('auto.components.status.bar.StatusBar.c8857b40f7', 'Refresh usage data')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3">
        <UpdateStatusSegment compact={compact} iconOnly={iconOnly} />
        <React.Suspense fallback={null}>
          {petEnabled ? <PetStatusSegment /> : null}
          {showResourceUsage ? (
            <ResourceUsageStatusSegment compact={compact} iconOnly={iconOnly} />
          ) : null}
          {showPorts ? <PortsStatusSegment compact={compact} iconOnly={iconOnly} /> : null}
          {showSsh ? <SshStatusSegment compact={compact} iconOnly={iconOnly} /> : null}
        </React.Suspense>
        {showFloatingTerminalToggle && (
          <FloatingTerminalIconContextMenu currentLocation="status-bar" className="relative">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="relative inline-flex size-5 cursor-pointer items-center justify-center rounded border border-border bg-secondary text-secondary-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                  aria-label={
                    showFloatingWorkspaceAttentionDot
                      ? `${floatingTerminalActionLabel}, new activity`
                      : floatingTerminalActionLabel
                  }
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(TOGGLE_FLOATING_TERMINAL_EVENT))
                  }}
                >
                  <PanelsTopLeft className="size-3.5" />
                  {showFloatingWorkspaceAttentionDot ? (
                    // Why: amber = Orca's "needs attention" convention; ring matches the fill so the dot reads on the icon.
                    <span
                      aria-hidden
                      data-floating-terminal-attention
                      className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500 ring-1 ring-secondary"
                    />
                  ) : null}
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
              {translate('auto.components.status.bar.StatusBar.3885eb74d8', 'Claude Usage')}
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
              {translate('auto.components.status.bar.StatusBar.c0909c686e', 'Codex Usage')}
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
              {translate('auto.components.status.bar.StatusBar.c1df0d67ec', 'Gemini Usage')}
            </DropdownMenuCheckboxItem>
          )}
          {isStatusBarItemAvailable('antigravity', detectedAgentIds) && (
            <DropdownMenuCheckboxItem
              checked={statusBarItems.includes('antigravity')}
              onCheckedChange={() => {
                recordFeatureInteraction('usage-tracking')
                toggleStatusBarItem('antigravity')
              }}
            >
              <AgentIcon agent="antigravity" size={14} />
              {translate(
                'auto.components.status.bar.StatusBar.antigravityUsage',
                'Antigravity Usage'
              )}
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
            {translate('auto.components.status.bar.StatusBar.8c86cd77b0', 'OpenCode Go Usage')}
          </DropdownMenuCheckboxItem>
          {isStatusBarItemAvailable('kimi', detectedAgentIds) && (
            <DropdownMenuCheckboxItem
              checked={statusBarItems.includes('kimi')}
              onCheckedChange={() => {
                recordFeatureInteraction('usage-tracking')
                toggleStatusBarItem('kimi')
              }}
            >
              <AgentIcon agent="kimi" size={14} />
              {translate('auto.components.status.bar.StatusBar.5e59007df4', 'Kimi Usage')}
            </DropdownMenuCheckboxItem>
          )}
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('minimax')}
            onCheckedChange={() => {
              recordFeatureInteraction('usage-tracking')
              toggleStatusBarItem('minimax')
            }}
          >
            <MiniMaxIcon size={14} />
            {translate('auto.components.status.bar.StatusBar.3bbf140864', 'MiniMax Usage')}
          </DropdownMenuCheckboxItem>
          {isStatusBarItemAvailable('grok', detectedAgentIds) && (
            <DropdownMenuCheckboxItem
              checked={statusBarItems.includes('grok')}
              onCheckedChange={() => {
                recordFeatureInteraction('usage-tracking')
                toggleStatusBarItem('grok')
              }}
            >
              <AgentIcon agent="grok" size={14} />
              {translate('auto.components.status.bar.StatusBar.grokUsageMenu', 'Grok Usage')}
            </DropdownMenuCheckboxItem>
          )}
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('ssh')}
            onCheckedChange={() => {
              recordFeatureInteraction('ssh')
              toggleStatusBarItem('ssh')
            }}
          >
            <Server className="size-3.5" />
            {translate('auto.components.status.bar.StatusBar.24ac89df1a', 'Remote Hosts')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('resource-usage')}
            onCheckedChange={() => {
              recordFeatureInteraction('resource-manager')
              toggleStatusBarItem('resource-usage')
            }}
          >
            <Activity className="size-3.5" />
            {translate('auto.components.status.bar.StatusBar.d1e1a7a6bf', 'Resource Manager')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('ports')}
            onCheckedChange={() => {
              recordFeatureInteraction('ports')
              toggleStatusBarItem('ports')
            }}
          >
            <Plug className="size-3.5" />
            {translate('auto.components.status.bar.StatusBar.9659e38343', 'Ports')}
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const StatusBar = React.memo(StatusBarInner)

/* eslint-disable max-lines -- Why: the status bar keeps provider rendering,
interaction menus, and compact-layout behavior together so the hover/click
states stay consistent across Claude and Codex. */
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw, Terminal, Wifi } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
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
import type { CodexRateLimitAccountsState } from '../../../../shared/types'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { ProviderIcon, ProviderPanel } from './tooltip'
import { ClaudeIcon, OpenAIIcon } from './icons'
import { markLiveCodexSessionsForRestart } from '@/lib/codex-session-restart'
import { SshStatusSegment } from './SshStatusSegment'
import { SessionsStatusSegment } from './SessionsStatusSegment'
import { UpdateStatusSegment } from './UpdateStatusSegment'

function getCodexAccountLabel(
  state: CodexRateLimitAccountsState,
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return 'System default'
  }
  return state.accounts.find((account) => account.id === accountId)?.email ?? 'Codex account'
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
  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {p.session && !compact && <MiniBar leftPct={Math.max(0, 100 - p.session.usedPercent)} />}
      {p.session && <WindowLabel w={p.session} label="5h" />}
      {p.session && p.weekly && <span className="text-muted-foreground">&middot;</span>}
      {p.weekly && <WindowLabel w={p.weekly} label="wk" />}
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
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const codexRestartNoticeByPtyId = useAppStore((s) => s.codexRestartNoticeByPtyId)
  const queueCodexPaneRestarts = useAppStore((s) => s.queueCodexPaneRestarts)
  const codexAccountSyncKey = useAppStore((s) => {
    const settings = s.settings
    if (!settings) {
      return 'no-settings'
    }
    return `${settings.activeCodexManagedAccountId ?? 'system'}:${settings.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  })

  const loadAccounts = useCallback(async () => {
    const next = await window.api.codexAccounts.list()
    setAccounts(next)
  }, [])

  useEffect(() => {
    // Why: the status bar keeps its own lightweight account snapshot for the
    // dropdown. Settings account actions mutate the main-process store outside
    // this component, so we refresh when the persisted account roster changes
    // or when the menu opens instead of leaving a stale account list mounted.
    void loadAccounts().catch((error) => {
      console.error('Failed to load Codex accounts for status bar:', error)
    })
  }, [loadAccounts, open, codexAccountSyncKey])

  const handleSelectAccount = async (accountId: string | null): Promise<void> => {
    if (isSwitching) {
      return
    }
    const previousActiveAccountId = accounts.activeAccountId
    setIsSwitching(true)
    try {
      const next = await window.api.codexAccounts.select({ accountId })
      setAccounts(next)
      await fetchSettings()
      if (previousActiveAccountId !== next.activeAccountId) {
        await markLiveCodexSessionsForRestart({
          previousAccountLabel: getCodexAccountLabel(accounts, previousActiveAccountId),
          nextAccountLabel: getCodexAccountLabel(next, next.activeAccountId)
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

  useEffect(() => {
    if (!open) {
      setAccountsExpanded(false)
    }
  }, [open])

  const activeAccountLabel =
    accounts.activeAccountId === null
      ? 'System default'
      : (accounts.accounts.find((account) => account.id === accounts.activeAccountId)?.email ??
        'Managed')
  const availableSwitchTargets = [
    ...(accounts.activeAccountId === null
      ? []
      : [{ id: null as string | null, label: 'System default' }]),
    ...accounts.accounts
      .filter((account) => account.id !== accounts.activeAccountId)
      .map((account) => ({
        id: account.id,
        label: account.workspaceLabel
          ? `${account.email} (${account.workspaceLabel})`
          : account.email
      }))
  ]
  const staleCodexPtyIds = Object.keys(codexRestartNoticeByPtyId)
  const staleCodexTabIds = Object.keys(ptyIdsByTabId).filter((tabId) =>
    (ptyIdsByTabId[tabId] ?? []).some((ptyId) => Boolean(codexRestartNoticeByPtyId[ptyId]))
  )
  const staleCodexWorktreeCount = new Set(
    Object.entries(tabsByWorktree).flatMap(([worktreeId, tabs]) =>
      tabs.some((tab) => staleCodexTabIds.includes(tab.id)) ? [worktreeId] : []
    )
  ).size
  const staleCodexSessionCount = staleCodexPtyIds.length
  const staleCodexTabCount = staleCodexTabIds.length

  return (
    <ProviderDetailsMenu
      provider={codex}
      compact={compact}
      iconOnly={iconOnly}
      ariaLabel="Open Codex details and account switcher"
      open={open}
      onOpenChange={setOpen}
    >
      <DropdownMenuLabel>Codex Account</DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          setAccountsExpanded((prev) => !prev)
        }}
      >
        <span className="max-w-[180px] truncate text-[12px] text-foreground">
          {activeAccountLabel}
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
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1">
            {availableSwitchTargets.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">No other accounts</div>
            ) : null}
            {availableSwitchTargets.map((target) => (
              <DropdownMenuItem
                key={target.id ?? 'system'}
                onSelect={(event) => {
                  // Why: account switching may need an immediate follow-up
                  // restart action for live Codex tabs. Prevent the menu from
                  // auto-closing so that prompt can stay within the same
                  // account-switcher interaction instead of jumping elsewhere.
                  event.preventDefault()
                  void handleSelectAccount(target.id)
                }}
                disabled={isSwitching}
              >
                <span className="truncate">{target.label}</span>
              </DropdownMenuItem>
            ))}
          </div>
        </div>
      ) : null}
      {staleCodexTabCount > 0 ? (
        <>
          <DropdownMenuSeparator />
          <div className="px-2 py-2">
            <div className="text-[11px] text-muted-foreground">
              {/* Why: stale restart notices are tracked per PTY session, but the
              bulk restart action operates per PTY-backed pane restart. Show
              both counts so split panes do not make the number look wrong. */}
              {staleCodexSessionCount === 1
                ? '1 Codex session is still on the old account'
                : `${staleCodexSessionCount} Codex sessions are still on the old account.`}
              {staleCodexWorktreeCount > 1 ? (
                <span className="mt-0.5 block">
                  Visible sessions restart now. Others restart when their worktree becomes active.
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => queueCodexPaneRestarts(staleCodexPtyIds)}
              className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
            >
              {staleCodexSessionCount === 1
                ? 'Restart Session'
                : `Restart ${staleCodexSessionCount} Sessions`}
            </button>
          </div>
        </>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'general',
            repoId: null,
            sectionId: 'general-codex-accounts'
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
  open,
  onOpenChange,
  children
}: {
  provider: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  ariaLabel: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
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
                {provider.provider === 'claude' ? 'C' : 'X'}
              </span>
            </span>
          ) : (
            <ProviderSegment p={provider} compact={compact} />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[260px]">
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

function StatusBarInner(): React.JSX.Element | null {
  const rateLimits = useAppStore((s) => s.rateLimits)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const statusBarItems = useAppStore((s) => s.statusBarItems)
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

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing, refreshRateLimits])

  if (!statusBarVisible) {
    return null
  }

  const { claude, codex } = rateLimits

  // Why: hiding `unavailable` providers makes the status bar appear to lose a
  // provider at random after refreshes or wake/resume. Keeping the slot visible
  // preserves layout stability and makes it obvious that the provider is still
  // configured but currently unavailable.
  const showClaude = claude && statusBarItems.includes('claude')
  const showCodex = codex && statusBarItems.includes('codex')
  const showSsh = statusBarItems.includes('ssh')
  const showSessions = statusBarItems.includes('sessions')
  const anyVisible = showClaude || showCodex
  const anyFetching = claude?.status === 'fetching' || codex?.status === 'fetching'

  const compact = containerWidth < 900
  const iconOnly = containerWidth < 500

  return (
    <div
      ref={containerRefCallback}
      className="flex items-center h-6 min-h-[24px] px-3 gap-4 border-t border-border bg-[var(--bg-titlebar,var(--card))] text-xs select-none shrink-0 relative"
      onContextMenuCapture={(event) => {
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
        {showClaude && (
          <ProviderDetailsMenu
            provider={claude}
            compact={compact}
            iconOnly={iconOnly}
            ariaLabel="Open Claude usage details"
          />
        )}
        {showCodex && <CodexSwitcherMenu codex={codex} compact={compact} iconOnly={iconOnly} />}
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
        {showSessions && <SessionsStatusSegment compact={compact} iconOnly={iconOnly} />}
        {showSsh && <SshStatusSegment compact={compact} iconOnly={iconOnly} />}
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
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('claude')}
            onCheckedChange={() => toggleStatusBarItem('claude')}
          >
            <ClaudeIcon size={14} />
            Claude Usage
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('codex')}
            onCheckedChange={() => toggleStatusBarItem('codex')}
          >
            <OpenAIIcon size={14} />
            Codex Usage
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('ssh')}
            onCheckedChange={() => toggleStatusBarItem('ssh')}
          >
            <Wifi className="size-3.5" />
            SSH Status
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={statusBarItems.includes('sessions')}
            onCheckedChange={() => toggleStatusBarItem('sessions')}
          >
            <Terminal className="size-3.5" />
            Terminal Sessions
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const StatusBar = React.memo(StatusBarInner)

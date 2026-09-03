import { useCallback, useEffect, useRef, useState } from 'react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '../../store'
import { selectFloatingWorkspaceHasUnread } from '../../store/selectors'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import { getVisibleUsageProvider, isUsageEmptyState } from './status-bar-provider-visibility'
import { getUsageProviderAccountsSectionId } from './usage-provider-settings-target'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT, useStatusBarMenuFocusHandoff } from './ProviderDetailsMenu'
import { observeStatusBarContainer } from './status-bar-container-observer'

export function useStatusBarController(floatingTerminalOpen: boolean) {
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
      resizeObserverRef.current = observeStatusBarContainer(node, setContainerWidth)
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

  return {
    anyFetching,
    anyVisible,
    compact,
    containerRefCallback,
    detectedAgentIds,
    floatingTerminalActionLabel,
    floatingTerminalShortcut,
    handleManageAccounts,
    handleOpenProviderAccounts,
    handleRefresh,
    handleUsageDetails,
    handleUsageMenuOpenChange,
    hasVisibleUsageMeters,
    iconOnly,
    isEmptyUsageState,
    isRefreshing,
    menuOpen,
    menuPoint,
    petEnabled,
    recordFeatureInteraction,
    rosterProviders,
    setMenuOpen,
    setMenuPoint,
    setStatusBarUsageMode,
    showEmptyUsageCta,
    showFloatingTerminalToggle,
    showFloatingWorkspaceAttentionDot,
    showPorts,
    showResourceUsage,
    showSsh,
    statusBarItems,
    statusBarUsageMode,
    toggleStatusBarItem,
    usageMenuFocusHandoff,
    usageMenuOpen,
    usagePercentageDisplay
  }
}

export type StatusBarController = NonNullable<ReturnType<typeof useStatusBarController>>

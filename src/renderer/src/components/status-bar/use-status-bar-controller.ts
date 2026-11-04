import { useCallback, useEffect, useRef, useState } from 'react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '../../store'
import { selectFloatingWorkspaceHasUnread } from '../../store/selectors'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { deriveUsageRosterProviders } from './usage-roster-providers'
import {
  getUsageProviderAccountsSectionId,
  usageRowSignInOpensSettings
} from './usage-provider-settings-target'
import { useStatusBarMenuFocusHandoff } from './ProviderDetailsMenu'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import { useStatusBarDensity } from './status-bar-density'
import { getUsageOwnerHostScope, useOwnerUsageRateLimits } from './use-owner-usage-rate-limits'
import { translate } from '@/i18n/i18n'

export function useStatusBarController(floatingTerminalOpen: boolean) {
  const floatingTerminalShortcut = useShortcutLabel('floatingTerminal.toggle')
  const localRateLimits = useAppStore((s) => s.rateLimits)
  // Why: with a remote account owner the agents run there, so its usage is the one to show.
  const { rateLimits, remoteOwner, refreshRemote } = useOwnerUsageRateLimits(localRateLimits)
  const remoteOwned = remoteOwner !== null
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
  const localDetectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  // Why: PATH detection describes this viewer, not the remote host whose bars are shown.
  const detectedAgentIds = remoteOwned ? null : localDetectedAgentIds
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  // Why: pet segment is driven purely by experimentalPet, not statusBarItems, to avoid double-toggling the surface (see design doc).
  const petEnabled = useAppStore((s) => s.settings?.experimentalPet === true)
  const toggleStatusBarItem = useAppStore((s) => s.toggleStatusBarItem)
  const usageEmptyStateDismissed = useAppStore((s) => s.usageEmptyStateDismissed)
  const mountedRef = useRef(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const {
    density: { compact, usageTightestOnly, segmentsIconOnly, collapseUsage },
    overflowing,
    collapsedUsageProviders,
    barRef,
    usageRef,
    segmentsRef
  } = useStatusBarDensity()

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

  const refreshDetectedAgents = useAppStore((s) => s.refreshDetectedAgents)
  const handleRefresh = useCallback(async () => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    try {
      // Why: re-run PATH detection so a freshly-installed/removed CLI's bar appears/hides without restarting Orca.
      await Promise.all([
        (refreshRemote ?? refreshRateLimits)(),
        refreshDetectedAgents(undefined, { wakeWslDistro: true })
      ])
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false)
      }
    }
  }, [isRefreshing, refreshRemote, refreshRateLimits, refreshDetectedAgents])

  if (!statusBarVisible) {
    return null
  }

  const { rosterProviders, hasVisibleUsageMeters, isEmptyUsageState, anyFetching } =
    deriveUsageRosterProviders({
      rateLimits,
      remoteOwned,
      settings,
      statusBarItems,
      detectedAgentIds
    })

  const showSsh = statusBarItems.includes('ssh')
  const showResourceUsage = statusBarItems.includes('resource-usage')
  const showPorts = statusBarItems.includes('ports')
  const showFloatingTerminalToggle =
    floatingTerminalEnabled && floatingTerminalTriggerLocation === 'status-bar'

  const anyVisible = hasVisibleUsageMeters || showResourceUsage
  const showEmptyUsageCta = isEmptyUsageState && !usageEmptyStateDismissed

  const floatingTerminalActionLabel = floatingTerminalOpen
    ? translate(
        'auto.components.status.bar.floatingWorkspace.minimize',
        'Minimize Floating Workspace'
      )
    : translate('auto.components.status.bar.floatingWorkspace.show', 'Show Floating Workspace')
  const showFloatingWorkspaceAttentionDot = !floatingTerminalOpen && hasFloatingUnread

  // Why: the shown accounts are the owning host's; without a scope Settings opens on the default host.
  const hostScope = getUsageOwnerHostScope(remoteOwner)
  const handleManageAccounts = (): void => {
    setUsageMenuOpen(false)
    openSettingsTarget({ pane: 'accounts', repoId: null, hostScope })
    openSettingsPage()
  }
  const handleUsageDetails = (): void => {
    setUsageMenuOpen(false)
    openSettingsTarget({ pane: 'stats', repoId: null })
    openSettingsPage()
  }
  const handleOpenProviderAccounts = (provider: ProviderRateLimits['provider']): void => {
    const sectionId = getUsageProviderAccountsSectionId(provider)
    // Why: a placeholder for a CLI-owned provider still leads to the host's accounts.
    if (!sectionId && !remoteOwner) {
      return
    }
    setUsageMenuOpen(false)
    openSettingsTarget({
      pane: 'accounts',
      repoId: null,
      hostScope,
      ...(sectionId ? { sectionId } : {})
    })
    openSettingsPage()
  }
  const canSignInFromUsageRow = (provider: ProviderRateLimits['provider']): boolean =>
    usageRowSignInOpensSettings(provider, settings)
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
    barRef,
    canSignInFromUsageRow,
    collapseUsage,
    collapsedUsageProviders,
    compact,
    detectedAgentIds,
    floatingTerminalActionLabel,
    floatingTerminalShortcut,
    handleManageAccounts,
    handleOpenProviderAccounts,
    handleRefresh,
    handleUsageDetails,
    handleUsageMenuOpenChange,
    hasVisibleUsageMeters,
    isEmptyUsageState,
    isRefreshing,
    menuOpen,
    menuPoint,
    overflowing,
    petEnabled,
    recordFeatureInteraction,
    remoteOwner,
    rosterProviders,
    segmentsIconOnly,
    segmentsRef,
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
    usagePercentageDisplay,
    usageRef,
    usageTightestOnly
  }
}

export type StatusBarController = NonNullable<ReturnType<typeof useStatusBarController>>

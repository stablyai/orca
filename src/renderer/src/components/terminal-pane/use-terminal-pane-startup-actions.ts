import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import { useProjectHostSetupProjection, useRepoById } from '@/store/selectors'
import { useSessionRestoredBannerDismiss } from './useSessionRestoredBannerDismiss'
import {
  addSessionRestoredBannerPaneId,
  dismissSessionRestoredBannerPaneIds,
  removeSessionRestoredBannerPaneId,
  type SessionRestoredBannerDismissEvent,
  type SessionRestoredBannerReason
} from './session-restored-banner-pane-state'
import { isTerminalZeroDimensionsDiagnostic } from '../../../../shared/terminal-zero-dimensions-diagnostic'
import { mapPaneTerminalErrors } from './terminal-error-accumulation'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type {
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/terminal-quick-command-types'
import { createTerminalQuickCommandDraft } from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { getCachedTerminalGroupIdForWorktree } from './terminal-unified-tab-lookup'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import { useNotificationDispatch } from './use-notification-dispatch'
import type { TerminalPaneStoreController } from './use-terminal-pane-store-bindings'

export function useTerminalPaneStartupActions(controller: TerminalPaneStoreController) {
  const {
    consumeTabIssueCommandSplit,
    consumeTabSetupSplit,
    consumeTabStartupCommand,
    containerRef,
    issueCommandSplit,
    isVisible,
    managerRef,
    onPtyExit,
    openSpacePage,
    quickCommandEditorHostId,
    refreshWorkspaceSpace,
    requestLinkRoutingPreference,
    sessionRestoredBannerPaneIds,
    setQuickCommandDraft,
    setQuickCommandEditorHostId,
    setQuickCommandEditorOpen,
    setSessionRestoredBannerPaneIds,
    setSessionStateSaveFailureOpen,
    setShouldMeasureHiddenStartup,
    setTerminalError,
    setTerminalErrorsByPaneId,
    settings,
    setupSplit,
    shouldMeasureHiddenStartup,
    startup,
    tabId,
    updateSettings,
    worktreeId
  } = controller
  const settleTabStartupCommand = useCallback(() => {
    if (startup) {
      consumeTabStartupCommand(tabId, startup)
    }
  }, [consumeTabStartupCommand, startup, tabId])

  useLayoutEffect(() => {
    if (isVisible && shouldMeasureHiddenStartup) {
      setShouldMeasureHiddenStartup(false)
    }
    if (isVisible) {
      setTerminalError((previous) =>
        previous && isTerminalZeroDimensionsDiagnostic(previous) ? null : previous
      )
      setTerminalErrorsByPaneId((current) =>
        mapPaneTerminalErrors(current, (message) =>
          isTerminalZeroDimensionsDiagnostic(message) ? null : message
        )
      )
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [isVisible, shouldMeasureHiddenStartup])

  const clearSessionRestoredBannerForPane = useCallback((paneId: number): void => {
    setSessionRestoredBannerPaneIds((previous) => {
      const next = removeSessionRestoredBannerPaneId(previous, paneId)
      return next === previous ? previous : next
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [])
  const showRestoredSessionBanner = useCallback(
    (paneId: number, reason: SessionRestoredBannerReason = 'restored'): void => {
      setSessionRestoredBannerPaneIds((previous) => {
        const next = addSessionRestoredBannerPaneId(previous, paneId, reason)
        return next === previous ? previous : next
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    []
  )
  const dismissSessionRestoredBanner = useCallback(
    (event: SessionRestoredBannerDismissEvent): void => {
      setSessionRestoredBannerPaneIds((previous) =>
        dismissSessionRestoredBannerPaneIds(previous, event, managerRef.current?.getPanes() ?? [])
      )
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    []
  )
  useSessionRestoredBannerDismiss(
    sessionRestoredBannerPaneIds.size > 0,
    containerRef,
    dismissSessionRestoredBanner
  )

  const openDiskSpaceAnalyzer = useCallback(() => {
    setSessionStateSaveFailureOpen(false)
    openSpacePage()
    void refreshWorkspaceSpace().catch((error: unknown) => {
      console.warn('Failed to refresh Space Analyzer after terminal session save failure:', error)
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [openSpacePage, refreshWorkspaceSpace])

  const quickCommandRepoId =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? null : getRepoIdFromWorktreeId(worktreeId)
  const quickCommandRepo = useRepoById(quickCommandRepoId)
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const quickCommandRepoLabel = quickCommandRepo
    ? quickCommandRepo.displayName || quickCommandRepo.path
    : quickCommandRepoId
      ? 'This Repo'
      : null
  const quickCommandGroupId =
    useAppStore(
      (state) =>
        getCachedTerminalGroupIdForWorktree(state.unifiedTabsByWorktree, worktreeId, tabId) ??
        state.activeGroupIdByWorktree[worktreeId] ??
        null
    ) ?? null

  const openQuickCommandEditor = useCallback(
    (scope: TerminalQuickCommandScope, hostId: ExecutionHostId): void => {
      setQuickCommandDraft(createTerminalQuickCommandDraft(scope))
      setQuickCommandEditorHostId(hostId)
      setQuickCommandEditorOpen(true)
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    []
  )
  const saveQuickCommand = useCallback(
    (command: TerminalQuickCommand): void => {
      void useAppStore.getState().upsertTerminalQuickCommand(quickCommandEditorHostId, command)
    },
    [quickCommandEditorHostId]
  )
  useEffect(() => {
    if (setupSplit) {
      consumeTabSetupSplit(tabId)
    }
  }, [setupSplit, tabId, consumeTabSetupSplit])
  useEffect(() => {
    if (issueCommandSplit) {
      consumeTabIssueCommandSplit(tabId)
    }
  }, [issueCommandSplit, tabId, consumeTabIssueCommandSplit])

  const settingsRef = useRef(settings)
  // Startup callbacks can run before the next effect commit.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  settingsRef.current = settings
  const openLinksInAppPreferencePromiseRef = useRef<Promise<boolean> | null>(null)
  const requestOpenLinksInAppPreference = useCallback(
    (url: string): Promise<boolean> | null => {
      if (settingsRef.current?.openLinksInAppPreferencePrompted === true) {
        return null
      }
      if (!settingsRef.current) {
        return null
      }
      if (openLinksInAppPreferencePromiseRef.current) {
        return openLinksInAppPreferencePromiseRef.current
      }
      const preferencePromise = (async () => {
        const openInOrca = await requestLinkRoutingPreference({
          openLinksInAppDefault: settingsRef.current?.openLinksInApp === true,
          url
        })
        await updateSettings({
          openLinksInApp: openInOrca,
          openLinksInAppPreferencePrompted: true
        })
        return openInOrca
      })()
      openLinksInAppPreferencePromiseRef.current = preferencePromise
      void preferencePromise.finally(() => {
        openLinksInAppPreferencePromiseRef.current = null
      })
      return preferencePromise
    },
    [requestLinkRoutingPreference, updateSettings]
  )
  const effectiveMacOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  const macOptionAsAltRef = useRef<MacOptionAsAlt>(effectiveMacOptionAsAlt)
  // Keyboard listeners need the current preference without a render lag.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  macOptionAsAltRef.current = effectiveMacOptionAsAlt
  const onPtyExitRef = useRef(onPtyExit)
  // PTY teardown may call this ref before passive effects flush.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  onPtyExitRef.current = onPtyExit
  const systemPrefersDark = useSystemPrefersDark()
  const dispatchNotification = useNotificationDispatch(worktreeId)
  const { setCacheTimerStartedAt } = useTerminalPaneStoreActions()

  return {
    clearSessionRestoredBannerForPane,
    showRestoredSessionBanner,
    dismissSessionRestoredBanner,
    openDiskSpaceAnalyzer,
    quickCommandRepoId,
    projectHostSetupProjection,
    quickCommandRepoLabel,
    quickCommandGroupId,
    openQuickCommandEditor,
    saveQuickCommand,
    settleTabStartupCommand,
    settingsRef,
    requestOpenLinksInAppPreference,
    effectiveMacOptionAsAlt,
    macOptionAsAltRef,
    onPtyExitRef,
    systemPrefersDark,
    dispatchNotification,
    setCacheTimerStartedAt
  }
}

export type TerminalPaneStartupController = TerminalPaneStoreController &
  ReturnType<typeof useTerminalPaneStartupActions>

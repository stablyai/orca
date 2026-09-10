import { useEffect } from 'react'
import type { IDisposable } from '@xterm/xterm'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../shared/terminal-scrollback-policy'
import { applyTerminalAppearance } from './terminal-appearance'
import { installMouseHideWhileTyping } from './mouse-hide-while-typing'
import {
  applyTerminalScrollbackRowsToMountedPanes,
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume
} from './terminal-pane-lifecycle-primitives'
import {
  reconcileMissingSessions,
  type ReconcilableBinding
} from './terminal-dead-session-reconcile'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import { useTerminalPaneMountLifecycle } from './use-terminal-pane-mount-lifecycle'
import { useTerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'

export {
  applyTerminalScrollbackRowsToMountedPanes,
  clearQueuedInitialCwdAfterFirstPane,
  createQueuedStartupConsumer,
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume,
  mapRestoredPaneTitlesByPaneId,
  paneOwnsQueuedStartup,
  replayLayoutWithOneShotParkIntent,
  resetTerminalKeyboardProtocolAfterInterrupt,
  resolvePaneLinkCwd,
  resolvePaneSeedCwd,
  resolveQueuedInitialCwd,
  recordRuntimeCreatedTerminalPaneSplit,
  shouldDetachPaneTransportOnUnmount,
  terminalSelectionExceedsPrimaryLimit,
  splitPaneWithOneShotStartup
} from './terminal-pane-lifecycle-primitives'
export {
  applyTerminalPaneCloseRequest,
  retireMountedTerminalPaneSurface,
  suppressIntentionalPaneCloseExit
} from './terminal-pane-lifecycle-close'
export type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'

/** Coordinates mount, visibility, and live appearance effects for terminal panes. */
export function useTerminalPaneLifecycle(deps: UseTerminalPaneLifecycleDeps): void {
  const refs = useTerminalPaneLifecycleRefs()
  useTerminalPaneMountLifecycle(deps, refs)

  const terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
    deps.settings?.terminalScrollbackRows
  )
  const systemPrefersDarkRef = refs.systemPrefersDarkRef
  systemPrefersDarkRef.current = deps.systemPrefersDark

  useEffect(() => {
    const onWakeHibernatedAgents = (event: Event): void => {
      const detail = (event as CustomEvent<{ worktreeId: string; wokenClaimKeys?: Set<string> }>)
        .detail
      if (!detail || detail.worktreeId !== deps.worktreeId) {
        return
      }
      for (const panePtyBinding of deps.panePtyBindingsRef.current.values()) {
        const claimKey = (panePtyBinding as IDisposableWithWake).wakeHibernatedAgentIfArmed?.(
          detail.wokenClaimKeys
        )
        if (claimKey) {
          detail.wokenClaimKeys?.add(claimKey)
        }
      }
    }
    window.addEventListener('orca:wake-hibernated-agents-worktree', onWakeHibernatedAgents)
    return () =>
      window.removeEventListener('orca:wake-hibernated-agents-worktree', onWakeHibernatedAgents)
  }, [deps.worktreeId, deps.panePtyBindingsRef])

  useEffect(() => {
    const previousIsVisible = getPreviousVisibleForTerminalPane({
      previous: refs.previousVisibleForReconcileRef.current,
      tabId: deps.tabId,
      cwd: deps.cwd
    })
    refs.previousVisibleForReconcileRef.current = {
      tabId: deps.tabId,
      cwd: deps.cwd,
      isVisible: deps.isVisible
    }
    deps.isVisibleRef.current = deps.isVisible
    const resumedFromHidden = isTerminalPaneVisibilityResume({
      previousIsVisible,
      isVisible: deps.isVisible
    })
    for (const panePtyBinding of deps.panePtyBindingsRef.current.values()) {
      const binding = panePtyBinding as IDisposableWithVisibility
      binding.syncProcessTracking?.()
      if (resumedFromHidden) {
        binding.noteVisibilityResume?.()
      }
    }
    if (resumedFromHidden && typeof window.api.pty.hasPty === 'function') {
      reconcileMissingSessions({
        bindings: deps.panePtyBindingsRef.current.values() as Iterable<ReconcilableBinding>,
        hasPty: window.api.pty.hasPty
      })
    }
  }, [
    deps.cwd,
    deps.isVisible,
    deps.isVisibleRef,
    deps.panePtyBindingsRef,
    deps.tabId,
    refs.previousVisibleForReconcileRef
  ])

  useEffect(() => {
    if (!deps.isActive || !deps.isVisible || typeof window === 'undefined') {
      return
    }
    const onWindowFocus = (): void => {
      const activePane = deps.managerRef.current?.getActivePane()
      if (!activePane) {
        return
      }
      const binding = deps.panePtyBindingsRef.current.get(activePane.id) as
        | (IDisposable & { sampleForegroundAgentOnFocus?: () => void })
        | undefined
      binding?.sampleForegroundAgentOnFocus?.()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [deps.isActive, deps.isVisible, deps.managerRef, deps.panePtyBindingsRef])

  useEffect(() => {
    const manager = deps.managerRef.current
    const currentSettings = deps.settingsRef.current
    if (!manager || !deps.settings || !currentSettings) {
      return
    }
    applyTerminalAppearance(
      manager,
      currentSettings,
      systemPrefersDarkRef.current,
      deps.paneFontSizesRef.current,
      deps.paneTransportsRef.current,
      deps.effectiveMacOptionAsAltRef.current,
      deps.paneMode2031Ref.current,
      deps.paneLastThemeModeRef.current
    )
  }, [
    deps.settings,
    deps.systemPrefersDark,
    deps.effectiveMacOptionAsAlt,
    deps.managerRef,
    deps.settingsRef,
    deps.paneFontSizesRef,
    deps.paneTransportsRef,
    deps.effectiveMacOptionAsAltRef,
    deps.paneMode2031Ref,
    deps.paneLastThemeModeRef,
    systemPrefersDarkRef
  ])

  useEffect(() => {
    deps.managerRef.current?.setTerminalGpuAcceleration(
      deps.settings?.terminalGpuAcceleration ?? 'auto'
    )
  }, [deps.settings?.terminalGpuAcceleration, deps.managerRef])

  useEffect(() => {
    const manager = deps.managerRef.current
    if (!manager) {
      return
    }
    applyTerminalScrollbackRowsToMountedPanes(manager, terminalScrollbackRows)
  }, [deps.managerRef, terminalScrollbackRows])

  useEffect(() => {
    const manager = deps.managerRef.current
    if (!manager) {
      return
    }
    const hide = deps.settings?.terminalMouseHideWhileTyping ?? false
    for (const pane of manager.getPanes()) {
      const existing = refs.mouseHideDisposablesRef.current.get(pane.id)
      if (hide && !existing) {
        refs.mouseHideDisposablesRef.current.set(
          pane.id,
          installMouseHideWhileTyping(pane.terminal, pane.container)
        )
      } else if (!hide && existing) {
        existing.dispose()
        refs.mouseHideDisposablesRef.current.delete(pane.id)
      }
    }
  }, [deps.settings?.terminalMouseHideWhileTyping, deps.managerRef, refs.mouseHideDisposablesRef])
}

type IDisposableWithWake = IDisposable & {
  wakeHibernatedAgentIfArmed?: (claimedProviderSessions?: Set<string>) => string | null
}

type IDisposableWithVisibility = IDisposable & {
  syncProcessTracking?: () => void
  noteVisibilityResume?: () => void
}

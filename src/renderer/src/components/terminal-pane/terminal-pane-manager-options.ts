import type { IDisposable } from '@xterm/xterm'
import type { PaneManagerOptions } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../shared/terminal-scrollback-policy'
import { normalizeTerminalTuiMouseWheelMultiplier } from '@/lib/pane-manager/pane-terminal-mouse-wheel'
import {
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity,
  resolveTerminalCursorInactiveStyle
} from '@/lib/pane-manager/pane-terminal-options'
import { buildFontFamily } from './layout-serialization'
import { buildWindowsPtyCompatibilityOptions } from '@/lib/pane-manager/windows-pty-compatibility'
import { buildTerminalKeyboardProtocolOptions } from '@/lib/pane-manager/terminal-keyboard-protocol'
import { resolvePaneKeyboardProtocolAgent } from './terminal-keyboard-protocol-pane-agent'
import { getConnectionId } from '@/lib/connection-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { acquireWebviewsDragPassthrough } from '../browser-pane/host-guest/webview-registry'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'
import { createTerminalPaneCreatedHandler } from './terminal-pane-pane-created'
import { createTerminalPaneClosedHandler } from './terminal-pane-pane-closed'
import {
  formatTerminalUrlTooltip,
  reportActiveRendererPtyForPane
} from './terminal-pane-lifecycle-primitives'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import type { TerminalPaneManagerOptionsContext } from './terminal-pane-mount-context'

/** Builds the imperative PaneManager option bag from the mount context. */
export function createTerminalPaneManagerOptions(
  context: TerminalPaneManagerOptionsContext
): PaneManagerOptions {
  const { deps, ptyDeps } = context
  const {
    tabId,
    worktreeId,
    settingsRef,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    isVisibleRef,
    requestOpenLinksInAppPreference,
    resolveExternalPaneDropTarget,
    onExternalPaneDrop
  } = deps
  return {
    onPaneCreated: createTerminalPaneCreatedHandler(context),
    onPaneClosed: createTerminalPaneClosedHandler(context),
    onActivePaneChange: (pane) => {
      const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
      const ptyIdsByLeafId = layout?.ptyIdsByLeafId ?? {}
      if (Object.keys(ptyIdsByLeafId).length > 0 && !ptyIdsByLeafId[pane.leafId]) {
        const fallbackLeafId = resolveTerminalLayoutActiveLeafId({
          root: layout?.root,
          activeLeafId: pane.leafId,
          ptyIdsByLeafId
        })
        const fallbackPaneId = fallbackLeafId
          ? (managerRef.current?.getNumericIdForLeaf(fallbackLeafId) ?? null)
          : null
        if (fallbackPaneId != null && fallbackPaneId !== pane.id) {
          managerRef.current?.setActivePane(fallbackPaneId, { focus: true })
          return
        }
      }
      scheduleRuntimeGraphSync()
      context.syncPaneLayoutRevision()
      if (context.shouldPersistLayout()) {
        context.deps.persistLayoutSnapshot()
      }
      reportActiveRendererPtyForPane(paneTransportsRef.current, pane.id)
      const focusedBinding = panePtyBindingsRef.current.get(pane.id) as
        | (IDisposable & { sampleForegroundAgentOnFocus?: () => void })
        | undefined
      focusedBinding?.sampleForegroundAgentOnFocus?.()
      const paneTitle = useAppStore.getState().runtimePaneTitlesByTabId[tabId]?.[pane.id]
      if (paneTitle) {
        context.deps.updateTabTitle(tabId, paneTitle)
      }
    },
    onLayoutChanged: () => {
      scheduleRuntimeGraphSync()
      context.deps.syncExpandedLayout()
      context.syncCanExpandState()
      context.syncPaneCount()
      context.syncPaneLayoutRevision()
      context.queueResizeAll(false)
      if (context.shouldPersistLayout()) {
        context.deps.persistLayoutSnapshot()
      }
    },
    onPaneDragActiveChange: (active) => {
      if (active) {
        context.releaseWebviewDragPassthrough.current?.()
        context.releaseWebviewDragPassthrough.current = acquireWebviewsDragPassthrough()
        return
      }
      context.releaseWebviewDragPassthrough.current?.()
      context.releaseWebviewDragPassthrough.current = null
    },
    resolveExternalPaneDropTarget,
    onExternalPaneDrop,
    terminalOptions: () => {
      const currentSettings = settingsRef.current
      const terminalFontWeights = resolveTerminalFontWeights(
        currentSettings?.terminalFontWeight,
        currentSettings?.terminalFontWeightBold
      )
      const cursorStyle = currentSettings?.terminalCursorStyle ?? 'block'
      const storeState = useAppStore.getState()
      const currentTab = storeState.tabsByWorktree[worktreeId]?.find(
        (candidate) => candidate.id === tabId
      )
      const platformInfo = window.api.platform?.get?.()
      const knownTuiAgent = resolvePaneKeyboardProtocolAgent(
        ptyDeps.startup,
        currentTab?.launchAgent
      )
      const ptyBackendContext = {
        userAgent: navigator.userAgent,
        osRelease: platformInfo?.osRelease,
        connectionId: getConnectionId(worktreeId),
        cwd: context.startupCwd,
        shellOverride: currentTab?.shellOverride,
        executionHostId: getExecutionHostIdForWorktree(storeState, worktreeId),
        tuiAgent: knownTuiAgent
      }
      return {
        ...buildWindowsPtyCompatibilityOptions(ptyBackendContext),
        ...buildTerminalKeyboardProtocolOptions(ptyBackendContext),
        fontSize: currentSettings?.terminalFontSize ?? 14,
        fontFamily: buildFontFamily(currentSettings?.terminalFontFamily ?? ''),
        fontWeight: terminalFontWeights.fontWeight,
        fontWeightBold: terminalFontWeights.fontWeightBold,
        scrollback: normalizeDesktopTerminalScrollbackRows(currentSettings?.terminalScrollbackRows),
        cursorStyle,
        cursorInactiveStyle: resolveTerminalCursorInactiveStyle(cursorStyle),
        cursorBlink: currentSettings?.terminalCursorBlink ?? true,
        scrollSensitivity: normalizeTerminalScrollSensitivity(
          currentSettings?.terminalScrollSensitivity
        ),
        fastScrollSensitivity: normalizeTerminalFastScrollSensitivity(
          currentSettings?.terminalFastScrollSensitivity
        ),
        macOptionIsMeta: context.deps.effectiveMacOptionAsAltRef.current === 'true',
        lineHeight: normalizeTerminalLineHeight(currentSettings?.terminalLineHeight),
        wordSeparator: currentSettings?.terminalWordSeparator
      }
    },
    terminalTuiScrollSensitivity: () =>
      normalizeTerminalTuiMouseWheelMultiplier(settingsRef.current?.terminalTuiScrollSensitivity),
    onLinkClick: (paneId, event, url) => {
      const activePane = managerRef.current?.getPanes().find((candidate) => candidate.id === paneId)
      handleTerminalWebLinkClick(url, event, {
        ...context.linkDeps,
        terminal: activePane?.terminal ?? null,
        startupCwd: activePane ? context.getPaneLinkCwd(paneId) : context.startupCwd,
        runtimeEnvironmentId: activePane
          ? (context.linkDeps.getRuntimeEnvironmentIdForPane?.(paneId) ?? null)
          : null,
        sourceOwner: activePane ? context.getHttpLinkSourceOwnerForPane(paneId) : { kind: 'local' },
        requestOpenLinksInAppPreference,
        linkActionContext: context.getLinkActionContext(paneId),
        actionDestinations: context.getHttpLinkActionDestinations(paneId)
      })
    },
    linkOpenHint: context.getUrlOpenLinkHint,
    formatLinkTooltip: (paneId, url, hint) =>
      formatTerminalUrlTooltip(url, hint, context.getHttpLinkSourceOwnerForPane(paneId)),
    initialRenderingSuspended: !isVisibleRef.current,
    terminalGpuAcceleration: settingsRef.current?.terminalGpuAcceleration ?? 'auto',
    debugLabel: `tab:${tabId}/wt:${worktreeId}`
  }
}

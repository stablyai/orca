import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import type {
  TerminalHttpLinkActionDestinations,
  TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'
import {
  createFilePathLinkProvider,
  installFilePathLinkClickFallback
} from './terminal-link-handlers'
import { createTerminalHandleLinkProvider } from './terminal-handle-links'
import { installTerminalLinkifierClickPriming } from './terminal-linkifier-click-priming'
import { installTerminalLinkPointerGesture } from './terminal-link-pointer-gesture'
import { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'
import { handleOscLink } from './terminal-osc-link-routing'
import { copyTerminalSelection } from './terminal-selection-copy'
import { installMouseHideWhileTyping } from './mouse-hide-while-typing'
import { isPrimarySelectionEnabled, setPrimarySelectionText } from '@/lib/primary-selection'
import {
  formatTerminalUrlTooltip,
  terminalSelectionExceedsPrimaryLimit
} from './terminal-pane-lifecycle-primitives'
import { seedStartupSessionRestoredBanner } from './session-restored-banner-pane-state'

type PaneLinkContext = {
  pane: ManagedPane
  managerRef: React.RefObject<PaneManager | null>
  settingsRef: React.RefObject<GlobalSettings | null | undefined>
  refs: Pick<
    TerminalPaneLifecycleRefs,
    | 'linkProviderDisposablesRef'
    | 'terminalHandleLinkDisposablesRef'
    | 'linkifierClickPrimingDisposablesRef'
    | 'linkPointerGesturesRef'
    | 'fileLinkClickFallbackDisposablesRef'
    | 'httpLinkClickFallbackDisposablesRef'
    | 'selectionDisposablesRef'
    | 'selectionCaptureTimersRef'
    | 'mouseHideDisposablesRef'
  >
  linkDeps: LinkHandlerDeps
  fileOpenLinkHint: string
  requestOpenLinksInAppPreference: TerminalLinkRoutingPreferenceRequester
  getHttpLinkSourceOwnerForPane: (paneId: number) => HttpLinkSourceOwner
  getHttpLinkActionDestinations: (paneId: number) => TerminalHttpLinkActionDestinations
  getLinkActionContext: (paneId: number) => TerminalLinkActionContext | null
  getPaneLinkCwd: (paneId: number) => string
  getUrlOpenLinkHint: (paneId: number) => string
  onShowSessionRestoredBanner: (paneId: number) => void
  ptyStartup: Parameters<typeof seedStartupSessionRestoredBanner>[0]
}

/** Installs path/URL links, selection capture, and pointer behavior for a pane. */
export function installTerminalPaneLinkHandling(context: PaneLinkContext): void {
  const {
    pane,
    managerRef,
    settingsRef,
    refs,
    linkDeps,
    fileOpenLinkHint,
    requestOpenLinksInAppPreference,
    getHttpLinkSourceOwnerForPane,
    getHttpLinkActionDestinations,
    getLinkActionContext,
    getPaneLinkCwd,
    getUrlOpenLinkHint,
    onShowSessionRestoredBanner,
    ptyStartup
  } = context
  const linkPointerGesture = installTerminalLinkPointerGesture(pane.terminal)
  refs.linkPointerGesturesRef.current.set(pane.id, linkPointerGesture)
  refs.linkProviderDisposablesRef.current.set(
    pane.id,
    pane.terminal.registerLinkProvider(
      createFilePathLinkProvider(pane.id, linkDeps, pane.linkTooltip, fileOpenLinkHint)
    )
  )
  refs.terminalHandleLinkDisposablesRef.current.set(
    pane.id,
    pane.terminal.registerLinkProvider(
      createTerminalHandleLinkProvider({
        getTerminal: () =>
          managerRef.current?.getPanes().find((candidate) => candidate.id === pane.id)?.terminal ??
          null,
        getRuntimeEnvironmentId: () => linkDeps.getRuntimeEnvironmentIdForPane?.(pane.id) ?? null,
        linkTooltip: pane.linkTooltip,
        getLinkActionContext: () => getLinkActionContext(pane.id)
      })
    )
  )
  refs.linkifierClickPrimingDisposablesRef.current.set(
    pane.id,
    installTerminalLinkifierClickPriming(pane.terminal)
  )
  refs.fileLinkClickFallbackDisposablesRef.current.set(
    pane.id,
    installFilePathLinkClickFallback(pane.id, pane.terminal, linkDeps)
  )
  refs.httpLinkClickFallbackDisposablesRef.current.set(
    pane.id,
    installHttpLinkClickFallback(pane.terminal, {
      ...linkDeps,
      getSourceOwner: () => getHttpLinkSourceOwnerForPane(pane.id),
      requestOpenLinksInAppPreference,
      getLinkActionContext: () => getLinkActionContext(pane.id),
      getActionDestinations: () => getHttpLinkActionDestinations(pane.id)
    })
  )
  seedStartupSessionRestoredBanner(ptyStartup, pane.id, onShowSessionRestoredBanner)

  refs.selectionDisposablesRef.current.set(
    pane.id,
    pane.terminal.onSelectionChange(() => {
      const shouldWritePrimarySelection = isPrimarySelectionEnabled()
      const shouldWriteClipboard = settingsRef.current?.terminalClipboardOnSelect === true
      if (!shouldWritePrimarySelection && !shouldWriteClipboard) {
        return
      }
      if (!pane.terminal.hasSelection()) {
        return
      }
      if (
        shouldWritePrimarySelection &&
        !shouldWriteClipboard &&
        terminalSelectionExceedsPrimaryLimit(pane.terminal)
      ) {
        return
      }
      if (shouldWritePrimarySelection) {
        const existingTimer = refs.selectionCaptureTimersRef.current.get(pane.id)
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer)
        }
        const timer = window.setTimeout(() => {
          refs.selectionCaptureTimersRef.current.delete(pane.id)
          if (!isPrimarySelectionEnabled() || !pane.terminal.hasSelection()) {
            return
          }
          if (terminalSelectionExceedsPrimaryLimit(pane.terminal)) {
            return
          }
          const selection = pane.terminal.getSelection()
          if (selection) {
            setPrimarySelectionText(selection)
          }
        }, 100)
        refs.selectionCaptureTimersRef.current.set(pane.id, timer)
      }
      if (!shouldWriteClipboard) {
        return
      }
      void copyTerminalSelection({
        terminal: pane.terminal,
        writeClipboardText: window.api.ui.writeTerminalClipboardText
      }).catch(() => {})
    })
  )
  if (settingsRef.current?.terminalMouseHideWhileTyping) {
    refs.mouseHideDisposablesRef.current.set(
      pane.id,
      installMouseHideWhileTyping(pane.terminal, pane.container)
    )
  }

  let oscTooltipHoverToken = 0
  pane.terminal.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, text) => {
      const handled = handleOscLink(text, event as MouseEvent | undefined, {
        ...linkDeps,
        startupCwd: getPaneLinkCwd(pane.id),
        runtimeEnvironmentId: linkDeps.getRuntimeEnvironmentIdForPane?.(pane.id) ?? null,
        sourceOwner: getHttpLinkSourceOwnerForPane(pane.id),
        requestOpenLinksInAppPreference,
        linkActionContext: getLinkActionContext(pane.id),
        actionDestinations: getHttpLinkActionDestinations(pane.id)
      })
      if (handled) {
        pane.terminal.clearSelection()
      }
    },
    hover: (_event, text) => {
      oscTooltipHoverToken += 1
      const hoverToken = oscTooltipHoverToken
      const hint = getUrlOpenLinkHint(pane.id)
      pane.linkTooltip.textContent = `${text} (${hint})`
      pane.linkTooltip.style.display = ''
      void formatTerminalUrlTooltip(text, hint, getHttpLinkSourceOwnerForPane(pane.id)).then(
        (nextText) => {
          if (hoverToken === oscTooltipHoverToken && nextText) {
            pane.linkTooltip.textContent = nextText
          }
        }
      )
    },
    leave: () => {
      oscTooltipHoverToken += 1
      pane.linkTooltip.style.display = 'none'
    }
  }
}

export type { PaneLinkContext }

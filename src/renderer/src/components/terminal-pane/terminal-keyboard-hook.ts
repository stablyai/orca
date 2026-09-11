import { useEffect } from 'react'
import type { KeybindingPlatform } from '../../../../shared/keybindings'
import type { KeyboardHandlersDeps } from './terminal-keyboard-dependencies'
import { createTerminalKeyboardRuntime } from './terminal-keyboard-runtime'
import { createTerminalKeyboardEventHandlers } from './terminal-keyboard-event-handlers'
import { prefetchLayoutCharacters } from '@/lib/keyboard-layout/layout-base-character'
import { useAppStore } from '@/store'

export type { KeyboardHandlersDeps } from './terminal-keyboard-dependencies'

/**
 * Installs terminal-pane shortcuts on the tab keyboard scope.
 * Uses the shared shortcut policy before forwarding unmatched input to xterm
 * so configurable Orca actions remain consistent across local and SSH panes.
 */
export function useTerminalKeyboardShortcuts({
  tabId,
  worktreeId,
  isActive,
  keyboardScopeRef,
  managerRef,
  paneTransportsRef,
  panePtyBindingsRef,
  paneCwdRef,
  fallbackCwd,
  expandedPaneIdRef,
  setExpandedPane,
  restoreExpandedLayout,
  refreshPaneSizes,
  persistLayoutSnapshot,
  toggleExpandPane,
  setSearchOpen,
  onSearchSelectedText,
  onRequestClosePane,
  onClearPaneScrollback,
  onSetTitle,
  onClearPaneTitle,
  searchOpenRef,
  searchStateRef,
  macOptionAsAltRef,
  paneKittyKeyboardModesRef,
  keybindings,
  terminalShortcutPolicy = 'orca-first'
}: KeyboardHandlersDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const isWindows = navigator.userAgent.includes('Windows')
    const shortcutPlatform: KeybindingPlatform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux'

    // Why: kitty Option-chord encoding resolves base keys through the async
    // KeyboardLayoutMap; prefetch so the map is cached before the first chord.
    if (isMac) {
      prefetchLayoutCharacters()
    }

    // Why: KeyboardEvent.location on a character key (e.g. Period) always
    // reports that key's own position (0 = standard), not which modifier is
    // held. Track each Option key independently and clear stale state on blur.
    const runtime = createTerminalKeyboardRuntime({
      tabId,
      worktreeId,
      isMac,
      isWindows,
      shortcutPlatform,
      keyboardScopeRef,
      managerRef,
      paneTransportsRef,
      panePtyBindingsRef,
      paneCwdRef,
      fallbackCwd,
      macOptionAsAltRef,
      paneKittyKeyboardModesRef,
      keybindings,
      terminalShortcutPolicy
    })
    const {
      optionKittyReleases,
      deferredNewlineSender,
      deferredChordSender,
      modifiedEnterChordOwner,
      observedEnterKeydownTimeStamps,
      onModifierDown
    } = runtime

    const eventHandlers = createTerminalKeyboardEventHandlers({
      tabId,
      worktreeId,
      isActive,
      keyboardScopeRef,
      managerRef,
      paneTransportsRef,
      panePtyBindingsRef,
      paneCwdRef,
      fallbackCwd,
      expandedPaneIdRef,
      setExpandedPane,
      restoreExpandedLayout,
      refreshPaneSizes,
      persistLayoutSnapshot,
      toggleExpandPane,
      setSearchOpen,
      onSearchSelectedText,
      onRequestClosePane,
      onClearPaneScrollback,
      onSetTitle,
      onClearPaneTitle,
      searchOpenRef,
      searchStateRef,
      macOptionAsAltRef,
      paneKittyKeyboardModesRef,
      keybindings,
      terminalShortcutPolicy,
      ...runtime,
      isMac,
      isWindows,
      shortcutPlatform,
      getKeyboardSplitTelemetrySource: () =>
        useAppStore.getState().activeContextualTourId === 'workspace-agent-sessions'
          ? 'contextual_tour'
          : 'keyboard'
    })
    const {
      onKeyDown,
      onKeyUp,
      onNativeOnlyShortcutCompanion,
      onNativeOnlyBeforeInput,
      onNativeOnlyBlur
    } = eventHandlers

    window.addEventListener('keydown', onModifierDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keypress', onNativeOnlyShortcutCompanion, { capture: true })
    window.addEventListener('keyup', onNativeOnlyShortcutCompanion, { capture: true })
    window.addEventListener('beforeinput', onNativeOnlyBeforeInput, { capture: true })
    window.addEventListener('blur', onNativeOnlyBlur)
    return () => {
      optionKittyReleases.clear()
      modifiedEnterChordOwner.clear()
      deferredNewlineSender.clearRedispatchedEnters()
      deferredChordSender.cancelPending()
      observedEnterKeydownTimeStamps.clear()
      window.removeEventListener('keydown', onModifierDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keypress', onNativeOnlyShortcutCompanion, { capture: true })
      window.removeEventListener('keyup', onNativeOnlyShortcutCompanion, { capture: true })
      window.removeEventListener('beforeinput', onNativeOnlyBeforeInput, { capture: true })
      window.removeEventListener('blur', onNativeOnlyBlur)
    }
  }, [
    isActive,
    keyboardScopeRef,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    paneCwdRef,
    fallbackCwd,
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onSearchSelectedText,
    onRequestClosePane,
    onClearPaneScrollback,
    onSetTitle,
    onClearPaneTitle,
    searchOpenRef,
    searchStateRef,
    macOptionAsAltRef,
    paneKittyKeyboardModesRef,
    keybindings,
    terminalShortcutPolicy,
    tabId,
    worktreeId
  ])
}

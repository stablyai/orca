import { useWebClientTerminalResize } from '../viewport/use-web-client-terminal-resize'
import { useRegularTerminalInputFocus } from '../input/focus/use-regular-terminal-input-focus'
import { useTerminalFontZoom } from '../appearance/useTerminalFontZoom'
import { useTerminalKeyboardShortcuts } from '../input/keyboard/terminal-keyboard-hook'
import { useTerminalPaneGlobalEffects } from '../viewport/visibility/use-terminal-pane-global-effects'
import type { TerminalPaneMountedController } from '../mounting/use-terminal-pane-lifecycle-stage'

export function useTerminalPaneGlobalListeners(controller: TerminalPaneMountedController): void {
  const {
    clearPaneScrollback,
    containerRef,
    cwd,
    expandedPaneIdRef,
    handleClearPaneTitleShortcut,
    handleRequestClosePane,
    handleSearchSelectedText,
    handleStartRename,
    effectiveChatViewMode,
    isActive,
    isActiveRef,
    isRendererVisible,
    isVisible,
    isVisibleRef,
    isWorktreeActive,
    keybindings,
    macOptionAsAltRef,
    managerRef,
    terminalManager,
    paneCount,
    paneCwdRef,
    paneKittyKeyboardModesRef,
    panePtyBindingsRef,
    paneTransportsRef,
    persistLayoutSnapshot,
    refreshPaneSizes,
    restoreExpandedLayout,
    searchOpenRef,
    searchStateRef,
    focusSearchInput,
    setExpandedPane,
    setSearchOpen,
    settings,
    settingsRef,
    shouldMeasureHiddenStartup,
    warmRendererWhileHidden,
    tabId,
    toggleExpandPane,
    worktreeId
  } = controller

  useTerminalFontZoom({ isActive, containerRef, managerRef, settingsRef })
  useTerminalKeyboardShortcuts({
    tabId,
    worktreeId,
    isActive: isActive && Boolean(terminalManager),
    keyboardScopeRef: containerRef,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    paneCwdRef,
    fallbackCwd: cwd ?? '',
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    focusSearchInput,
    onSearchSelectedText: handleSearchSelectedText,
    onRequestClosePane: handleRequestClosePane,
    onClearPaneScrollback: clearPaneScrollback,
    onSetTitle: handleStartRename,
    onClearPaneTitle: handleClearPaneTitleShortcut,
    searchOpenRef,
    searchStateRef,
    macOptionAsAltRef,
    paneKittyKeyboardModesRef,
    keybindings,
    terminalShortcutPolicy: settings?.terminalShortcutPolicy ?? 'orca-first'
  })
  useTerminalPaneGlobalEffects({
    terminalManager,
    tabId,
    cwd,
    isActive,
    isVisible,
    isChatViewMode: effectiveChatViewMode,
    isWorktreeActive,
    isSyncFitEnabled: isRendererVisible || shouldMeasureHiddenStartup,
    warmRendererWhileHidden: warmRendererWhileHidden === true,
    paneCount,
    managerRef,
    containerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    isActiveRef,
    isVisibleRef,
    toggleExpandPane
  })

  useWebClientTerminalResize({
    terminalManager,
    isActive,
    isVisible,
    managerRef,
    paneTransportsRef
  })

  useRegularTerminalInputFocus({ containerRef })
}

/* eslint-disable max-lines -- Why: terminal keyboard routing keeps shortcut
 * precedence in one ordered handler so shell input, pane commands, search, and
 * split actions do not race across separate window listeners. */
import { useEffect } from 'react'
import type { IDisposable } from '@xterm/xterm'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { safeFind } from '../terminal-search-safe-find'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import {
  keybindingMatchesAction,
  type KeybindingOverrides,
  type KeybindingPlatform,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { keyboardEventBelongsToScope } from './terminal-keyboard-scope'
import {
  getLayoutBaseCharacterForCode,
  prefetchLayoutBaseCharacters
} from '@/lib/keyboard-layout/layout-base-character'
import { normalizeSelectedTextForFileSearch } from '@/lib/file-search-selection'
import { isFindQueryTooLarge } from '@/lib/find-query-bounds'
import { handleEmptyFloatingWorkspacePanelCloseShortcut } from '@/lib/floating-workspace-terminal-actions'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import { useAppStore } from '@/store'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { isLocalWindowsConptyPaneForCtrlArrow } from './terminal-ctrl-arrow-conpty'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolveWindowsShiftEnterEncodingForPane } from './terminal-windows-shift-enter'
import {
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from '@/lib/pane-manager/terminal-scroll-intent'

export function recordKeyboardCreatedTerminalPaneSplit(
  createdPane: unknown,
  args: {
    source: 'contextual_tour' | 'keyboard'
    direction: 'vertical' | 'horizontal'
  }
): boolean {
  return recordCreatedTerminalPaneSplit(createdPane, args)
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm.js focuses a hidden <textarea class="xterm-helper-textarea"> for
  // keyboard input.  That element IS an editable target, but we must NOT
  // suppress terminal shortcuts when the terminal itself is focused.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  const editableAncestor = target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
  )
  return editableAncestor !== null
}

export type SearchState = {
  query: string
  caseSensitive: boolean
  regex: boolean
}

export type SearchNavigationDirection = 'next' | 'previous'

/**
 * Pure decision function for Cmd+G / Cmd+Shift+G search navigation.
 * Returns 'next', 'previous', or null (no match).
 * Extracted so the key-matching logic is testable without DOM dependencies.
 */
export function matchSearchNavigate(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean,
  searchOpen: boolean,
  searchState: SearchState
): SearchNavigationDirection | null {
  if (e.altKey) {
    return null
  }
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) {
    return null
  }
  if (e.key.toLowerCase() !== 'g') {
    return null
  }
  if (!searchOpen) {
    return null
  }
  if (!searchState.query) {
    return null
  }
  if (isFindQueryTooLarge(searchState.query)) {
    return null
  }
  return e.shiftKey ? 'previous' : 'next'
}

export function runTerminalSearchNavigation(
  pane: Pick<ManagedPane, 'searchAddon'>,
  direction: SearchNavigationDirection,
  searchState: SearchState
): boolean {
  const { query, caseSensitive, regex } = searchState
  const options = { caseSensitive, regex }

  // Why: Cmd/Ctrl+G hits the same xterm decoration path as the search panel,
  // so narrow-viewport highlight failures need the same containment.
  return direction === 'next'
    ? safeFind((term, findOptions) => pane.searchAddon.findNext(term, findOptions), query, options)
    : safeFind(
        (term, findOptions) => pane.searchAddon.findPrevious(term, findOptions),
        query,
        options
      )
}

export function matchFileSearchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat'>,
  platform: KeybindingPlatform,
  keybindings?: KeybindingOverrides,
  terminalShortcutPolicy: TerminalShortcutPolicy = 'orca-first'
): boolean {
  if (e.repeat) {
    return false
  }
  return keybindingMatchesAction('sidebar.search.toggle', e, platform, keybindings, {
    context: 'terminal',
    terminalShortcutPolicy
  })
}

type KeyboardHandlersDeps = {
  tabId: string
  worktreeId: string
  isActive: boolean
  keyboardScopeRef: React.RefObject<HTMLElement | null>
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  /** Worktree-root cwd used when OSC 7 and pty.getCwd both fail. */
  fallbackCwd: string
  expandedPaneIdRef: React.RefObject<number | null>
  setExpandedPane: (paneId: number | null) => void
  restoreExpandedLayout: () => void
  refreshPaneSizes: (focusActive: boolean) => void
  persistLayoutSnapshot: () => void
  toggleExpandPane: (paneId: number) => void
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  onSearchSelectedText: (text: string) => void
  onRequestClosePane: (paneId: number) => void
  onClearPaneScrollback: (pane: ManagedPane) => void
  onSetTitle: (paneId: number) => void
  onClearPaneTitle: (paneId: number) => void
  searchOpenRef: React.RefObject<boolean>
  searchStateRef: React.RefObject<SearchState>
  macOptionAsAltRef: React.RefObject<MacOptionAsAlt>
  paneKittyKeyboardModesRef?: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>
  keybindings?: KeybindingOverrides
  terminalShortcutPolicy?: TerminalShortcutPolicy
}

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
      prefetchLayoutBaseCharacters()
    }

    // Why: KeyboardEvent.location on a character key (e.g. Period) always
    // reports that key's own position (0 = standard), not which modifier is
    // held. To distinguish left vs right Option, we record the Option key's
    // location from its own keydown event and clear it on keyup.
    let optionKeyLocation = 0
    const onModifierDown = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        optionKeyLocation = e.location
      }
    }
    const onModifierUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        optionKeyLocation = 0
      }
    }

    // Why: this callback is installed once per active tab and invoked only for
    // Windows Shift+Enter, keeping store work and allocations off ordinary keys.
    const getActivePaneWindowsShiftEnterEncoding = () => {
      const manager = managerRef.current
      const activePane = manager?.getActivePane() ?? manager?.getPanes()[0]
      if (!activePane) {
        return 'alt-enter' as const
      }
      const state = useAppStore.getState()
      const paneKey = makePaneKey(tabId, activePane.leafId)
      return resolveWindowsShiftEnterEncodingForPane(state, paneKey)
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const keyboardScope = keyboardScopeRef.current
      if (keyboardScope && !keyboardEventBelongsToScope(e, keyboardScope)) {
        return
      }

      if (matchFileSearchShortcut(e, shortcutPlatform, keybindings, terminalShortcutPolicy)) {
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        const selectedText = normalizeSelectedTextForFileSearch(pane?.terminal.getSelection())
        if (selectedText) {
          e.preventDefault()
          e.stopImmediatePropagation()
          onSearchSelectedText(selectedText)
          return
        }
      }

      // Cmd+G / Cmd+Shift+G navigates terminal search matches even when focus
      // is inside the search input itself, so this check must run before the
      // editable-target guard would otherwise bypass all terminal shortcuts.
      // stopImmediatePropagation prevents App.tsx's Cmd+Shift+G (source-control sidebar) from also firing.
      const direction = matchSearchNavigate(e, isMac, searchOpenRef.current, searchStateRef.current)
      if (direction !== null) {
        if (e.repeat) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        runTerminalSearchNavigation(pane, direction, searchStateRef.current)
        pane.terminal.focus()
        return
      }

      if (isEditableTarget(e.target)) {
        return
      }

      if (handleEmptyFloatingWorkspacePanelCloseShortcut(e, shortcutPlatform, keybindings)) {
        return
      }

      // Why: the active pane's live PTY session decides whether Ctrl+Arrow should
      // pass through as native \e[1;5C/\e[1;5D or be translated to \eb/\ef.
      // Resolved lazily so session/runtime lookups stay off other keystrokes.
      const isLocalWindowsConptyPane = (): boolean => {
        const activePane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!activePane) {
          return false
        }
        const storeState = useAppStore.getState()
        return isLocalWindowsConptyPaneForCtrlArrow({
          isWindows,
          userAgent: navigator.userAgent,
          state: storeState,
          worktreeId,
          tabId,
          paneId: activePane.id,
          paneCwd: paneCwdRef.current,
          fallbackCwd,
          transport: paneTransportsRef.current.get(activePane.id) ?? null
        })
      }

      // Why: the pane's TUI opted into kitty keyboard reporting via CSI > u;
      // the tracker mirrors that from PTY output so the policy can encode
      // Option chords the way the application negotiated.
      const isKittyKeyboardActivePane = (): boolean => {
        const activePane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!activePane) {
          return false
        }
        return (paneKittyKeyboardModesRef?.current.get(activePane.id)?.flags ?? 0) > 0
      }

      const action = resolveTerminalShortcutAction(
        e,
        isMac,
        macOptionAsAltRef.current,
        optionKeyLocation,
        isWindows,
        keybindings,
        isLocalWindowsConptyPane,
        isKittyKeyboardActivePane,
        getLayoutBaseCharacterForCode,
        getActivePaneWindowsShiftEnterEncoding
      )
      if (!action) {
        return
      }

      if (action.type === 'sendInput') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        const sent = paneTransportsRef.current.get(pane.id)?.sendInput(action.data) === true
        if (sent) {
          recordTerminalUserInputForLeaf(tabId, pane.leafId)
          if (action.data === '\x1b[13;2u') {
            // Why: this direct shortcut write does not pass through PTY onData,
            // so no-OSC shells need an explicit post-write confirmation ladder.
            const binding = panePtyBindingsRef.current.get(pane.id) as
              | (IDisposable & { requestDroidReconfirmation?: () => void })
              | undefined
            binding?.requestDroidReconfirmation?.()
          }
        }
        return
      }

      if (e.repeat) {
        return
      }

      // Cmd/Ctrl+Shift+C copies terminal selection via Electron clipboard.
      // This ensures Linux terminal copy works consistently.
      if (action.type === 'copySelection') {
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        const selection = pane.terminal.getSelection()
        if (!selection) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        void window.api.ui.writeClipboardText(selection).catch(() => {
          /* ignore clipboard write failures */
        })
        return
      }

      // Keep Cmd+F bound to the terminal search until the app has a real
      // top-level find-in-page flow to fall back to.
      if (action.type === 'toggleSearch') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setSearchOpen((prev) => !prev)
        return
      }

      // Cmd+K clears active pane screen + scrollback.
      if (action.type === 'clearActivePane') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (pane) {
          onClearPaneScrollback(pane)
        }
        return
      }

      if (action.type === 'scrollViewport') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        if (action.position === 'top') {
          markTerminalPinnedViewport(pane.terminal)
          pane.terminal.scrollToLine(0)
          syncTerminalScrollIntentFromViewport(pane.terminal)
        } else {
          markTerminalFollowOutput(pane.terminal)
          pane.terminal.scrollToBottom()
          syncTerminalScrollIntentFromViewport(pane.terminal)
        }
        return
      }

      // Cmd+[ / Cmd+] cycles active split pane focus.
      if (action.type === 'focusPane') {
        const panes = manager.getPanes()
        if (panes.length < 2) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()

        // Collapse expanded pane before switching
        if (expandedPaneIdRef.current !== null) {
          setExpandedPane(null)
          restoreExpandedLayout()
          refreshPaneSizes(true)
          persistLayoutSnapshot()
        }

        const activeId = manager.getActivePane()?.id ?? panes[0].id
        const currentIdx = panes.findIndex((p) => p.id === activeId)
        if (currentIdx === -1) {
          return
        }

        const dir = action.direction === 'next' ? 1 : -1
        const nextPane = panes[(currentIdx + dir + panes.length) % panes.length]
        manager.setActivePane(nextPane.id, { focus: true })
        return
      }

      if (action.type === 'equalizePaneSizes') {
        // Consume the chord first so a user-assigned terminal shortcut can't fall
        // through to app-level zoom when an expanded pane blocks the equalize.
        e.preventDefault()
        e.stopImmediatePropagation()
        if (expandedPaneIdRef.current !== null) {
          return
        }
        manager.equalizePaneSizes()
        const paneToFocus = manager.getActivePane() ?? manager.getPanes()[0]
        paneToFocus?.terminal.focus()
        return
      }

      // Cmd+Shift+Enter expands/collapses the active pane to full terminal area.
      if (action.type === 'toggleExpandActivePane') {
        const panes = manager.getPanes()
        if (panes.length < 2) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? panes[0]
        if (!pane) {
          return
        }
        toggleExpandPane(pane.id)
        return
      }

      if (action.type === 'setTitle') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        onSetTitle(pane.id)
        return
      }

      if (action.type === 'clearPaneTitle') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        onClearPaneTitle(pane.id)
        return
      }

      // Cmd+W closes the active split pane (or the whole tab when only one
      // pane remains). Always intercepted here so the tab-level handler in
      // Terminal.tsx never closes the entire tab directly — that would kill
      // every pane instead of just the focused one.
      if (action.type === 'closeActivePane') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        onRequestClosePane(pane.id)
        return
      }

      // Cmd+D / Cmd+Shift+D split the active pane in the focused tab only.
      // Exit expanded mode first so the new split gets proper dimensions
      // (matches Ghostty behavior).
      if (action.type === 'splitActivePane') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (expandedPaneIdRef.current !== null) {
          setExpandedPane(null)
          restoreExpandedLayout()
          refreshPaneSizes(true)
          persistLayoutSnapshot()
        }
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        splitTerminalPaneWithInheritedCwd({
          manager,
          getManager: () => managerRef.current,
          paneTransports: paneTransportsRef.current,
          paneCwdMap: paneCwdRef.current,
          fallbackCwd,
          pane,
          direction: action.direction,
          source: getKeyboardSplitTelemetrySource()
        })
      }
    }

    window.addEventListener('keydown', onModifierDown, { capture: true })
    window.addEventListener('keyup', onModifierUp, { capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onModifierDown, { capture: true })
      window.removeEventListener('keyup', onModifierUp, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [
    isActive,
    keyboardScopeRef,
    managerRef,
    paneTransportsRef,
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

function getKeyboardSplitTelemetrySource(): 'contextual_tour' | 'keyboard' {
  return useAppStore.getState().activeContextualTourId === 'workspace-agent-sessions'
    ? 'contextual_tour'
    : 'keyboard'
}

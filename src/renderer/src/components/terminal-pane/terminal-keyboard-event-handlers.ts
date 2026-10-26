import { keybindingMatchesAction, type KeybindingPlatform } from '../../../../shared/keybindings'
import type { KeyboardHandlersDeps } from './terminal-keyboard-dependencies'
import type { createTerminalKeyboardRuntime } from './terminal-keyboard-runtime'
import { normalizeSelectedTextForFileSearch } from '@/lib/file-search-selection'
import { handleEmptyFloatingWorkspacePanelCloseShortcut } from '@/lib/floating-workspace-terminal-actions'
import { useAppStore } from '@/store'
import { hasPendingTerminalImeComposition } from './terminal-ime-composition-route'
import {
  isTerminalImeConsumedKey,
  isTerminalImeProcessEnter
} from './terminal-ime-deferred-newline'
import { keyboardEventBelongsToScope } from './terminal-keyboard-scope'
import {
  isEditableTarget,
  matchFileSearchShortcut,
  matchSearchNavigate,
  runTerminalSearchNavigation
} from './terminal-keyboard-shortcut-matching'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { getLayoutCharacterForCode } from '@/lib/keyboard-layout/layout-base-character'
import { createTerminalKeyboardReleaseHandlers } from './terminal-keyboard-release-handlers'
import { synchronizeTerminalKeyboardPane } from './terminal-keyboard-pane-resolution'
import { isInsideNativeChatCover } from './native-chat-covered-pane'

const MAX_OBSERVED_ENTER_KEYDOWNS_PER_CODE = 8

type Runtime = ReturnType<typeof createTerminalKeyboardRuntime>
type EventContext = KeyboardHandlersDeps & {
  isMac: boolean
  isWindows: boolean
  shortcutPlatform: KeybindingPlatform
  resolveShortcutEvent: Runtime['resolveShortcutEvent']
  createCapturedInputSender: Runtime['createCapturedInputSender']
  reconcileHeldImeEnterModifiers: Runtime['reconcileHeldImeEnterModifiers']
  getImeEnterModifier: Runtime['getImeEnterModifier']
  getModifiedEnterChord: Runtime['getModifiedEnterChord']
  getKeyboardSplitTelemetrySource: () => 'contextual_tour' | 'keyboard'
  nativeOnlyShortcutTracker: Runtime['nativeOnlyShortcutTracker']
  optionKeyLocations: Runtime['optionKeyLocations']
  optionKittyReleases: Runtime['optionKittyReleases']
  heldImeEnterModifiers: Runtime['heldImeEnterModifiers']
  terminalImeEnterModifierKeydowns: Runtime['terminalImeEnterModifierKeydowns']
  deferredNewlineSender: Runtime['deferredNewlineSender']
  deferredChordSender: Runtime['deferredChordSender']
  modifiedEnterChordOwner: Runtime['modifiedEnterChordOwner']
  observedEnterKeydownTimeStamps: Runtime['observedEnterKeydownTimeStamps']
}

export function createTerminalKeyboardEventHandlers(context: EventContext) {
  const {
    tabId,
    worktreeId,
    isMac,
    isWindows,
    shortcutPlatform,
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
    focusSearchInput,
    onSearchSelectedText,
    onRequestClosePane,
    onClearPaneScrollback,
    onSetTitle,
    onClearPaneTitle,
    searchOpenRef,
    searchStateRef,
    paneKittyKeyboardModesRef,
    keybindings,
    terminalShortcutPolicy,
    resolveShortcutEvent,
    createCapturedInputSender,
    reconcileHeldImeEnterModifiers,
    getModifiedEnterChord,
    nativeOnlyShortcutTracker,
    optionKittyReleases,
    terminalImeEnterModifierKeydowns,
    deferredNewlineSender,
    deferredChordSender,
    modifiedEnterChordOwner,
    observedEnterKeydownTimeStamps,
    getKeyboardSplitTelemetrySource
  } = context

  const onKeyDown = (e: KeyboardEvent): void => {
    // Replace only this key’s stale state; rollover must preserve held native chords awaiting Kitty keyup.
    nativeOnlyShortcutTracker.prepareKeyDown(e)
    // Record before early returns so every observed Enter disqualifies keyup synthesis.
    if (
      isWindows &&
      ((e.key === 'Enter' && e.keyCode === 13) ||
        (e.keyCode === 229 && (e.code === 'Enter' || e.code === 'NumpadEnter')))
    ) {
      const observed = observedEnterKeydownTimeStamps.get(e.code)
      if (!observed) {
        observedEnterKeydownTimeStamps.set(e.code, [e.timeStamp])
      } else if (!e.repeat && observed.length < MAX_OBSERVED_ENTER_KEYDOWNS_PER_CODE) {
        // Auto-repeat shares one physical release.
        observed.push(e.timeStamp)
      }
    }
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const keyboardScope = keyboardScopeRef.current
    if (keyboardScope && !keyboardEventBelongsToScope(e, keyboardScope)) {
      return
    }

    // Repair activePaneId from the focused helper before policies read pane-specific host/agent state.
    const keyboardPane = synchronizeTerminalKeyboardPane(manager, e.target)

    const modifiedEnterChord = isWindows ? getModifiedEnterChord(e) : null
    if (
      e.key === 'Enter' &&
      e.keyCode === 13 &&
      !e.isComposing &&
      (modifiedEnterChordOwner.ownsRedispatchedEnter() ||
        (modifiedEnterChord && modifiedEnterChordOwner.absorb(modifiedEnterChord)) ||
        deferredNewlineSender.absorbRedispatchedEnter(e))
    ) {
      // Chromium can drop the modifier when re-dispatching the committing Enter.
      reconcileHeldImeEnterModifiers(e)
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }

    const terminalPaneForImeShortcut = keyboardPane
    const hasPendingImeComposition = hasPendingTerminalImeComposition(
      terminalPaneForImeShortcut?.terminal.element
    )
    const imeProcessEnter = isWindows && hasPendingImeComposition && isTerminalImeProcessEnter(e)
    if (isWindows && hasPendingImeComposition && !imeProcessEnter && isTerminalImeConsumedKey(e)) {
      // Process has no logical key, so shortcut matching would fall back to its physical code.
      e.stopImmediatePropagation()
      return
    }

    if (matchFileSearchShortcut(e, shortcutPlatform, keybindings, terminalShortcutPolicy)) {
      const pane = keyboardPane
      const selectedText = normalizeSelectedTextForFileSearch(pane?.terminal.getSelection())
      if (selectedText) {
        e.preventDefault()
        e.stopImmediatePropagation()
        onSearchSelectedText(selectedText)
        return
      }
    }

    // Handle terminal search navigation before editable-target bypass so search-input focus still works.
    const direction = matchSearchNavigate(e, isMac, searchOpenRef.current, searchStateRef.current)
    if (direction !== null) {
      if (e.repeat) {
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      const pane = keyboardPane
      if (!pane) {
        return
      }
      runTerminalSearchNavigation(pane, direction, searchStateRef.current)
      pane.terminal.focus()
      return
    }

    if (isEditableTarget(e.target)) {
      if (
        searchOpenRef.current &&
        e.target instanceof HTMLElement &&
        e.target.closest('[data-terminal-search-root]') &&
        resolveShortcutEvent(e)?.type === 'toggleSearch'
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!e.repeat) {
          focusSearchInput()
        }
      }
      return
    }

    if (
      handleEmptyFloatingWorkspacePanelCloseShortcut(
        useAppStore.getState(),
        e,
        shortcutPlatform,
        keybindings
      )
    ) {
      return
    }

    const shortcutEvent = {
      key: imeProcessEnter ? 'Enter' : e.key,
      code: e.code,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      repeat: e.repeat,
      isComposing: e.isComposing || hasPendingImeComposition,
      keyCode: e.keyCode,
      getModifierState: (key: string) => e.getModifierState(key)
    }
    const action = resolveShortcutEvent(shortcutEvent)
    if (!action) {
      return
    }
    // Covering chat owns find and selection; the hidden terminal buffer is not the visible surface.
    if (
      isInsideNativeChatCover(e.target) &&
      (action.type === 'toggleSearch' ||
        action.type === 'selectAll' ||
        action.type === 'copySelection' ||
        keybindingMatchesAction('chat.find', e, shortcutPlatform, keybindings))
    ) {
      return
    }

    if (action.type === 'switchInputSource') {
      // Preserve the OS default action while suppressing the entire key lifecycle from xterm.
      nativeOnlyShortcutTracker.armKeyDown(e)
      e.stopImmediatePropagation()
      return
    }

    if (action.type === 'trackNativeOptionDeadKey') {
      optionKittyReleases.armNativeDeadKey(e)
      return
    }

    if (action.type === 'sendInput') {
      e.preventDefault()
      e.stopImmediatePropagation()
      const pane = keyboardPane
      if (!pane) {
        return
      }
      const sendResolvedInput = createCapturedInputSender(pane, action.data)
      if (action.consumeOptionKeyUp) {
        optionKittyReleases.armNativeDeadKey(e)
      } else if (action.optionKittyRelease) {
        optionKittyReleases.arm(
          e,
          action.optionKittyRelease,
          sendResolvedInput,
          () => paneKittyKeyboardModesRef?.current.get(pane.id)?.flags ?? 0,
          getLayoutCharacterForCode
        )
      }
      if ((e.isComposing || hasPendingImeComposition) && (e.key === 'Enter' || imeProcessEnter)) {
        if (isWindows) {
          const chord = getModifiedEnterChord(e)
          const claimedChord = chord
            ? {
                ...chord,
                terminalModifierKeyDownObserved: terminalImeEnterModifierKeydowns.has(chord.kind)
              }
            : null
          if (claimedChord && !modifiedEnterChordOwner.claim(claimedChord)) {
            return
          }
        }
        deferredNewlineSender.defer(e, pane.terminal.element, sendResolvedInput)
        return
      }
      // The held copy already sends a chord the IME replays on commit, even while xterm is still finalizing (#17616).
      if (deferredChordSender.absorbReplay(e)) {
        return
      }
      // Defer cursor chords until composed text commits or they overtake it (#12871); unlike Enter, timeout must drop rather than fire mid-preedit. Sender owns cancellation on blur/teardown.
      if (e.isComposing || hasPendingImeComposition) {
        deferredChordSender.defer(e, pane.terminal.element, sendResolvedInput)
        return
      }
      sendResolvedInput()
      return
    }

    dispatchTerminalShortcutAction(action, e, manager, {
      tabId,
      worktreeId,
      fallbackCwd,
      expandedPaneIdRef,
      setExpandedPane,
      restoreExpandedLayout,
      refreshPaneSizes,
      persistLayoutSnapshot,
      toggleExpandPane,
      setSearchOpen,
      focusSearchInput,
      searchOpenRef,
      onRequestClosePane,
      onClearPaneScrollback,
      onSetTitle,
      onClearPaneTitle,
      paneTransportsRef,
      paneCwdRef,
      managerRef,
      getKeyboardSplitTelemetrySource,
      armNativeOnlyShortcut: (event) => nativeOnlyShortcutTracker.armKeyDown(event)
    })
  }

  const { onKeyUp, onNativeOnlyShortcutCompanion, onNativeOnlyBeforeInput, onNativeOnlyBlur } =
    createTerminalKeyboardReleaseHandlers(context)

  return {
    onKeyDown,
    onKeyUp,
    onNativeOnlyShortcutCompanion,
    onNativeOnlyBeforeInput,
    onNativeOnlyBlur
  }
}

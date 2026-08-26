import type { KeybindingPlatform } from '../../../../shared/keybindings'
import type { KeyboardHandlersDeps } from './terminal-keyboard-dependencies'
import type { createTerminalKeyboardRuntime } from './terminal-keyboard-runtime'
import { normalizeSelectedTextForFileSearch } from '@/lib/file-search-selection'
import { handleEmptyFloatingWorkspacePanelCloseShortcut } from '@/lib/floating-workspace-terminal-actions'
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
    // Why: replace stale state only for this physical key so rollover cannot
    // disarm a still-held native-only chord before its Kitty keyup arrives.
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

    const terminalPaneForImeShortcut = manager.getActivePane() ?? manager.getPanes()[0]
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

    if (action.type === 'switchInputSource') {
      // Why: the OS must receive its default action, while xterm must receive
      // none of the keydown, keypress, or keyup sequence.
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
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
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
      // Why: the composed glyph reaches the pty from the composition session-end handler, which
      // runs after this keydown. Sending now puts a cursor chord ahead of the text it was typed
      // after — `가나다` then Cmd+Left leaves `다가나` (#12871). Enter is handled above, where a
      // fallback timer is right because a newline arriving late still arrives; a chord arriving
      // mid-preedit is the corruption itself, so this one waits on the composition rather than a
      // deadline. The sender owns the wait so blur and teardown can drop it.
      if (e.isComposing || hasPendingImeComposition) {
        deferredChordSender.defer(pane.terminal.element, sendResolvedInput)
        return
      }
      sendResolvedInput()
      return
    }

    dispatchTerminalShortcutAction(action, e, manager, {
      fallbackCwd,
      expandedPaneIdRef,
      setExpandedPane,
      restoreExpandedLayout,
      refreshPaneSizes,
      persistLayoutSnapshot,
      toggleExpandPane,
      setSearchOpen,
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

import type { KeyboardHandlersDeps } from './terminal-keyboard-dependencies'
import type { createTerminalKeyboardRuntime } from './terminal-keyboard-runtime'
import { isTerminalImeEnterKeyUp } from './terminal-ime-deferred-newline'
import { isEditableTarget } from './terminal-keyboard-shortcut-matching'
import { hasPendingTerminalImeComposition } from './terminal-ime-composition-route'
import { keyboardEventBelongsToScope } from './terminal-keyboard-scope'

type Runtime = ReturnType<typeof createTerminalKeyboardRuntime>
type ReleaseContext = KeyboardHandlersDeps &
  Pick<
    Runtime,
    | 'optionKeyLocations'
    | 'optionKittyReleases'
    | 'heldImeEnterModifiers'
    | 'terminalImeEnterModifierKeydowns'
    | 'deferredNewlineSender'
    | 'deferredChordSender'
    | 'modifiedEnterChordOwner'
    | 'observedEnterKeydownTimeStamps'
    | 'reconcileHeldImeEnterModifiers'
    | 'getImeEnterModifier'
    | 'resolveShortcutEvent'
    | 'createCapturedInputSender'
    | 'nativeOnlyShortcutTracker'
  >

type ReleaseContextWithPlatform = ReleaseContext & { isWindows: boolean }

export function createTerminalKeyboardReleaseHandlers(context: ReleaseContextWithPlatform) {
  const {
    keyboardScopeRef,
    managerRef,
    isWindows,
    optionKeyLocations,
    optionKittyReleases,
    heldImeEnterModifiers,
    terminalImeEnterModifierKeydowns,
    deferredNewlineSender,
    deferredChordSender,
    modifiedEnterChordOwner,
    observedEnterKeydownTimeStamps,
    reconcileHeldImeEnterModifiers,
    getImeEnterModifier,
    resolveShortcutEvent,
    createCapturedInputSender,
    nativeOnlyShortcutTracker
  } = context

  const onKeyUp = (e: KeyboardEvent): void => {
    if (!isTerminalImeEnterKeyUp(e)) {
      reconcileHeldImeEnterModifiers(e)
    }
    optionKeyLocations.keyUp(e)
    if (optionKittyReleases.settle(e)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    const releasedModifier = e.key === 'Shift' ? 'shift' : e.key === 'Control' ? 'ctrl' : null
    if (releasedModifier) {
      heldImeEnterModifiers.delete(releasedModifier)
      terminalImeEnterModifierKeydowns.delete(releasedModifier)
      modifiedEnterChordOwner.release({
        kind: releasedModifier,
        code: e.code,
        timeStamp: e.timeStamp
      })
    }
    if (e.key !== 'Enter') {
      return
    }
    const observed = observedEnterKeydownTimeStamps.get(e.code)
    const wasObserved = observed !== undefined
    if (wasObserved && !observed.includes(e.timeStamp)) {
      observed.shift()
      if (observed.length === 0) {
        observedEnterKeydownTimeStamps.delete(e.code)
      }
    }
    if (isWindows && isTerminalImeEnterKeyUp(e)) {
      const originatingChord = modifiedEnterChordOwner.releaseForEnterKeyUp()
      if (originatingChord) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const modifierStillMatches = getImeEnterModifier(e) === originatingChord.kind
        deferredNewlineSender.releaseRedispatchedEnter(
          e,
          modifierStillMatches || originatingChord.terminalModifierKeyDownObserved
            ? originatingChord
            : undefined
        )
        return
      }
      const modifiedKind = getImeEnterModifier(e)
      const manager = managerRef.current
      const scope = keyboardScopeRef.current
      if (
        modifiedKind &&
        !wasObserved &&
        manager &&
        !isEditableTarget(e.target) &&
        (!scope || keyboardEventBelongsToScope(e, scope))
      ) {
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (pane && hasPendingTerminalImeComposition(pane.terminal.element)) {
          const action = resolveShortcutEvent({
            key: 'Enter',
            code: e.code,
            metaKey: false,
            ctrlKey: modifiedKind === 'ctrl',
            altKey: false,
            shiftKey: modifiedKind === 'shift',
            repeat: false
          })
          if (action?.type === 'sendInput') {
            e.preventDefault()
            e.stopImmediatePropagation()
            deferredNewlineSender.defer(
              e,
              pane.terminal.element,
              createCapturedInputSender(pane, action.data)
            )
            return
          }
        }
      }
    }
    const modifiedKind = getImeEnterModifier(e)
    if (modifiedKind) {
      modifiedEnterChordOwner.release({ kind: modifiedKind, code: e.code, timeStamp: e.timeStamp })
    }
    deferredNewlineSender.releaseRedispatchedEnter(e)
  }

  const onNativeOnlyShortcutCompanion = (e: KeyboardEvent): void => {
    if (nativeOnlyShortcutTracker.consumeCompanion(e)) {
      if (e.type === 'keypress') {
        e.preventDefault()
      }
      e.stopImmediatePropagation()
    }
  }

  const onNativeOnlyBeforeInput = (e: Event): void => {
    if (!(e instanceof InputEvent) || !nativeOnlyShortcutTracker.shouldSuppressBeforeInput(e)) {
      return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  const onNativeOnlyBlur = (): void => {
    optionKeyLocations.clear()
    optionKittyReleases.clear()
    nativeOnlyShortcutTracker.clear()
    heldImeEnterModifiers.clear()
    terminalImeEnterModifierKeydowns.clear()
    modifiedEnterChordOwner.clear()
    deferredNewlineSender.clearRedispatchedEnters()
    deferredChordSender.cancelPending()
    observedEnterKeydownTimeStamps.clear()
  }

  return { onKeyUp, onNativeOnlyShortcutCompanion, onNativeOnlyBeforeInput, onNativeOnlyBlur }
}

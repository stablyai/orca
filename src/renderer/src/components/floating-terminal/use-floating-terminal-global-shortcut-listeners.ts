import { useEffect } from 'react'
import {
  isEventTargetInsideFloatingWorkspacePanel,
  isFloatingWorkspaceTerminalInputTarget,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingContext
} from '../../../../shared/keybindings'
import { toModifierDoubleTapEvent } from '../../../../shared/modifier-double-tap-detector'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelShortcuts } from './use-floating-terminal-panel-shortcuts'

type FloatingTerminalGlobalShortcutListenersInput = Pick<
  FloatingTerminalPanelLocalState,
  'panelRef' | 'doubleTapDetectorRef'
> &
  Pick<FloatingTerminalPanelShortcuts, 'floatingShortcutListenersRef'> & { open: boolean }

export function useFloatingTerminalGlobalShortcutListeners({
  panelRef,
  doubleTapDetectorRef,
  floatingShortcutListenersRef,
  open
}: FloatingTerminalGlobalShortcutListenersInput): void {
  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return
    }
    const doubleTapDetector = doubleTapDetectorRef.current
    const isPanelFocused = (): boolean => {
      const panel = panelRef.current
      const active = document.activeElement
      return Boolean(panel && active instanceof HTMLElement && panel.contains(active))
    }
    const handleFloatingPanelKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return
      }
      if (!isEventTargetInsideFloatingWorkspacePanel(event.target) && !isPanelFocused()) {
        doubleTapDetector?.reset()
        return
      }
      const detected = doubleTapDetector?.process(
        toModifierDoubleTapEvent({
          type: 'keyDown',
          code: event.code,
          key: event.key,
          shift: event.shiftKey,
          control: event.ctrlKey,
          alt: event.altKey,
          meta: event.metaKey,
          isAutoRepeat: event.repeat
        }),
        Date.now()
      )
      if (event.repeat) {
        return
      }
      const state = useAppStore.getState()
      const context: KeybindingContext = isFloatingWorkspaceTerminalInputTarget(event.target)
        ? 'terminal'
        : 'app'
      const matches = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, event, getShortcutPlatform(), state.keybindings, {
          context,
          terminalShortcutPolicy: state.settings?.terminalShortcutPolicy
        })
      const consume = (): void => {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
      }
      const dispatchShortcut =
        floatingShortcutListenersRef.current.handleFloatingPanelShortcutAction
      if (
        detected &&
        dispatchShortcut(
          { doubleTapModifier: detected.modifier, target: event.target },
          consume
        ) !== 'unmatched'
      ) {
        return
      }
      if (dispatchShortcut(event, consume) !== 'unmatched') {
        return
      }
      const switchSameTypeDirection = matches('tab.nextSameType')
        ? 1
        : matches('tab.previousSameType')
          ? -1
          : null
      const switchAllTypesDirection = matches('tab.nextAllTypes')
        ? 1
        : matches('tab.previousAllTypes')
          ? -1
          : null
      if (switchSameTypeDirection !== null || switchAllTypesDirection !== null) {
        consume()
        switchFloatingWorkspaceTab(
          useAppStore.getState(),
          switchAllTypesDirection ?? switchSameTypeDirection ?? 1,
          switchAllTypesDirection !== null ? 'all-types' : 'same-type'
        )
        return
      }
      const terminalTabDirection = matches('tab.nextTerminal')
        ? 1
        : matches('tab.previousTerminal')
          ? -1
          : null
      if (terminalTabDirection !== null) {
        consume()
        switchFloatingWorkspaceTab(useAppStore.getState(), terminalTabDirection, 'terminal')
      }
    }
    const handleFloatingPanelKeyUp = (event: KeyboardEvent): void => {
      if (!isPanelFocused()) {
        doubleTapDetector?.reset()
        return
      }
      doubleTapDetector?.process(
        toModifierDoubleTapEvent({
          type: 'keyUp',
          code: event.code,
          key: event.key,
          shift: event.shiftKey,
          control: event.ctrlKey,
          alt: event.altKey,
          meta: event.metaKey
        }),
        Date.now()
      )
    }
    const handleFloatingPanelBlur = (): void => doubleTapDetector?.reset()
    window.addEventListener('keydown', handleFloatingPanelKeyDown, { capture: true })
    window.addEventListener('keyup', handleFloatingPanelKeyUp, { capture: true })
    window.addEventListener('blur', handleFloatingPanelBlur)
    return () => {
      window.removeEventListener('keydown', handleFloatingPanelKeyDown, { capture: true })
      window.removeEventListener('keyup', handleFloatingPanelKeyUp, { capture: true })
      window.removeEventListener('blur', handleFloatingPanelBlur)
      doubleTapDetector?.reset()
    }
  }, [doubleTapDetectorRef, floatingShortcutListenersRef, open, panelRef])
}

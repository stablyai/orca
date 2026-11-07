import { useAppStore } from '@/store'
import {
  KEYBINDING_DEFINITIONS,
  keybindingMatchesAction,
  type KeybindingActionId
} from '../../../../../shared/keybindings'
import { claimCopyModeKey, consumeCopyModeEvent } from './terminal-copy-mode-key-guard'
import {
  copyModeSessionOwns,
  isCopyModeModalOpen,
  type TerminalCopyModeSessions
} from './terminal-copy-mode-session'

const TERMINAL_SELECTION_ACTIONS = [
  { id: 'terminal.selectAll', action: 'select-all' },
  { id: 'terminal.copySelection', action: 'copy' }
] as const

const TERMINAL_PASS_THROUGH_ACTIONS = new Set<KeybindingActionId>([
  'terminal.focusNextPane',
  'terminal.focusPreviousPane',
  'terminal.equalizePaneSizes',
  'terminal.expandPane',
  'terminal.closePane',
  'terminal.splitRight',
  'terminal.splitDown',
  'terminal.switchInputSource'
])
const COPY_MODE_PASS_THROUGH_ACTIONS = KEYBINDING_DEFINITIONS.filter(
  (definition) =>
    definition.scope === 'tabs' ||
    (definition.scope === 'global' && definition.id !== 'voice.dictation') ||
    TERMINAL_PASS_THROUGH_ACTIONS.has(definition.id)
)

const COPY_MODE_INPUT_EVENTS = [
  'beforeinput',
  'input',
  'paste',
  'drop',
  'compositionstart',
  'compositionupdate',
  'compositionend'
] as const

// The overlay lives inside the live pane, whose pointer paste handlers would otherwise resolve it.
const COPY_MODE_POINTER_EVENTS = ['contextmenu', 'mousedown', 'mouseup', 'auxclick'] as const

export function installTerminalCopyModeInputRouting({
  scope,
  platform,
  sessions
}: {
  scope: HTMLElement
  platform: NodeJS.Platform
  sessions: TerminalCopyModeSessions
}): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      isCopyModeModalOpen() ||
      !(event.target instanceof Node) ||
      !scope.contains(event.target)
    ) {
      return
    }
    sessions.validate()
    const state = useAppStore.getState()
    const options = {
      context: 'terminal' as const,
      terminalShortcutPolicy: state.settings?.terminalShortcutPolicy
    }
    const owner = sessions.current()
    if (!owner) {
      if (
        event.isComposing ||
        !keybindingMatchesAction(
          'terminal.enterCopyMode',
          event,
          platform,
          state.keybindings,
          options
        )
      ) {
        return
      }
      if (!event.repeat && sessions.enter()) {
        claimCopyModeKey(event, () => false)
        consumeCopyModeEvent(event)
      }
      return
    }
    if (!copyModeSessionOwns(owner, event.target)) {
      return
    }
    if (!owner.view.contains(event.target)) {
      owner.view.focus()
    }
    const ownsRepeat = (): boolean => sessions.current() === owner
    if (event.isComposing || owner.view.handleKeyDown(event)) {
      claimCopyModeKey(event, ownsRepeat)
      consumeCopyModeEvent(event)
      return
    }
    const selectionAction = TERMINAL_SELECTION_ACTIONS.find(({ id }) =>
      keybindingMatchesAction(id, event, platform, state.keybindings, options)
    )
    if (selectionAction) {
      claimCopyModeKey(event, ownsRepeat)
      consumeCopyModeEvent(event)
      if (!event.repeat) {
        owner.view.handleMenuSelectionAction(selectionAction.action)
      }
      return
    }
    if (
      COPY_MODE_PASS_THROUGH_ACTIONS.some((definition) =>
        keybindingMatchesAction(definition.id, event, platform, state.keybindings, options)
      )
    ) {
      return
    }
    claimCopyModeKey(event, ownsRepeat)
    consumeCopyModeEvent(event)
  }
  const onInput = (event: Event): void => {
    const session = sessions.current()
    if (session && !isCopyModeModalOpen() && copyModeSessionOwns(session, event.target)) {
      consumeCopyModeEvent(event)
    }
  }
  const onPointer = (event: MouseEvent): void => {
    const session = sessions.current()
    // Primary-button presses keep their focus behavior inside the overlay.
    if (event.type !== 'contextmenu' && event.button === 0) {
      return
    }
    if (session?.view.contains(event.target)) {
      consumeCopyModeEvent(event)
    }
  }
  window.addEventListener('keydown', onKeyDown, true)
  for (const type of COPY_MODE_INPUT_EVENTS) {
    window.addEventListener(type, onInput, true)
  }
  for (const type of COPY_MODE_POINTER_EVENTS) {
    window.addEventListener(type, onPointer, true)
  }
  return () => {
    window.removeEventListener('keydown', onKeyDown, true)
    for (const type of COPY_MODE_INPUT_EVENTS) {
      window.removeEventListener(type, onInput, true)
    }
    for (const type of COPY_MODE_POINTER_EVENTS) {
      window.removeEventListener(type, onPointer, true)
    }
  }
}

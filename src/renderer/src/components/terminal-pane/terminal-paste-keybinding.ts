import { resolveKeybindingAction } from '../../../../shared/keybindings/effective-keymap'
import type {
  EffectiveKeymap,
  KeybindingEvent
} from '../../../../shared/keybindings/keybinding-types'

export function isTerminalPasteKeybinding(
  event: KeybindingEvent,
  keymap: EffectiveKeymap
): boolean {
  const action = resolveKeybindingAction(keymap, event, 'terminal')
  return action?.command.type === 'terminalPaste'
}

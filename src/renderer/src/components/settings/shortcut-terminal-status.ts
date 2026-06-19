import {
  isKeybindingAllowedInTerminal,
  isKeybindingPotentialTerminalConflict,
  keybindingIsActiveInContext,
  type KeybindingDefinition,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'
import type { ShortcutTerminalStatus } from './ShortcutBindingRow'

export function getShortcutTerminalStatus(
  definition: KeybindingDefinition,
  terminalShortcutPolicy: TerminalShortcutPolicy,
  hasEffectiveBinding: boolean
): ShortcutTerminalStatus | undefined {
  if (!hasEffectiveBinding) {
    return undefined
  }
  if (definition.scope === 'terminal') {
    return {
      label: translate('auto.components.settings.ShortcutsPane.cb02e00202', 'Terminal'),
      description: translate(
        'auto.components.settings.ShortcutsPane.781cb74d22',
        'Runs from terminal panes.'
      )
    }
  }
  if (isKeybindingAllowedInTerminal(definition)) {
    return {
      label: translate('auto.components.settings.ShortcutsPane.25b0004fbf', 'Terminal active'),
      description: translate(
        'auto.components.settings.ShortcutsPane.3c0fac059a',
        'Still runs while a terminal has keyboard focus.'
      )
    }
  }
  if (!isKeybindingPotentialTerminalConflict(definition)) {
    return undefined
  }
  const activeInTerminal = keybindingIsActiveInContext(definition, {
    context: 'terminal',
    terminalShortcutPolicy
  })
  return activeInTerminal
    ? {
        label: translate('auto.components.settings.ShortcutsPane.2a0e8aeccf', 'Orca first'),
        description: translate(
          'auto.components.settings.ShortcutsPane.dfa8ff612f',
          'Also runs while a terminal or TUI has keyboard focus.'
        )
      }
    : {
        label: translate('auto.components.settings.ShortcutsPane.5c65d5db9d', 'Terminal first'),
        description: translate(
          'auto.components.settings.ShortcutsPane.f0b35b0b2e',
          'Disabled while a terminal or TUI has keyboard focus.'
        )
      }
}

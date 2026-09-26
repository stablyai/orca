import { translate } from '@/i18n/i18n'

/** Shown when a captured chord fails to normalize into a storable binding. */
export function getUnableToParseShortcutMessage(): string {
  return translate(
    'auto.components.settings.ShortcutsPane.unableToParseShortcut',
    'Unable to parse shortcut.'
  )
}

/** Shown when an action id no longer resolves to a known keybinding definition. */
export function getShortcutUnavailableMessage(): string {
  return translate(
    'auto.components.settings.ShortcutsPane.shortcutUnavailable',
    'Shortcut is no longer available.'
  )
}

/** Shared by the save-time blocking conflict error and the passive per-row
 *  conflict warning so both read as the same translated sentence. */
export function getBindingConflictMessage(binding: string, conflictLabels: string): string {
  return translate(
    'auto.components.settings.ShortcutsPane.bindingConflict',
    '{{value0}} conflicts with {{value1}}.',
    { value0: binding, value1: conflictLabels }
  )
}

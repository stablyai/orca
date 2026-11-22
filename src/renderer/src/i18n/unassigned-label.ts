import { translate } from '@/i18n/i18n'

/** English sentinel from shortcut formatters; translate only at display sites. */
export const UNASSIGNED_SHORTCUT_SENTINEL = 'Unassigned'

export function translateUnassignedLabel(): string {
  return translate('common.unassigned', 'Unassigned')
}

export function localizeUnassignedDisplay(value: string): string {
  return value === UNASSIGNED_SHORTCUT_SENTINEL ? translateUnassignedLabel() : value
}

/** True when a shortcut label is the unbound sentinel (EN or localized). */
export function isUnassignedShortcutLabel(value: string): boolean {
  return value === UNASSIGNED_SHORTCUT_SENTINEL || value === translateUnassignedLabel()
}

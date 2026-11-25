import type { BrowserExtensionContextMenuItem } from '../../../../../../shared/browser/extensions/browser-extension-context-menu-types'

export type BrowserExtensionMenuCheck = {
  role: 'menuitemcheckbox' | 'menuitemradio'
  checked: boolean
}

/** ARIA role and checked state for checkbox and radio items; undefined for other types. */
export function browserExtensionMenuCheck(
  item: BrowserExtensionContextMenuItem
): BrowserExtensionMenuCheck | undefined {
  if (item.type === 'checkbox') {
    return { role: 'menuitemcheckbox', checked: item.checked }
  }
  if (item.type === 'radio') {
    return { role: 'menuitemradio', checked: item.checked }
  }
  return undefined
}

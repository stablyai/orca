import type { UpdateCheckOptions } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from './shortcut-platform'

type UpdateCheckClickEvent = Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

function isMacShortcutPlatform(): boolean {
  return getShortcutPlatform() === 'darwin'
}

export function getUpdateCheckHint(isMac = isMacShortcutPlatform()): string {
  // Why: surface channel modifiers as real UI copy (not a native title-only
  // tooltip) so RC/perf checks are discoverable and localizable (#10590).
  if (isMac) {
    return translate(
      'auto.lib.update-check-click-options.hint_mac',
      '⇧+click checks the latest RC; ⌘+click checks the latest perf build. ⌥+click chooses a local macOS build.'
    )
  }
  return translate(
    'auto.lib.update-check-click-options.hint_other',
    'Shift+click checks the latest RC; Ctrl+click checks the latest perf build.'
  )
}

/** Compact native menu / tray label suffix for modifier channels. */
export function getUpdateCheckMenuHint(isMac = isMacShortcutPlatform()): string {
  if (isMac) {
    return translate('auto.lib.update-check-click-options.menu_hint_mac', '⇧ RC · ⌘ Perf')
  }
  return translate('auto.lib.update-check-click-options.menu_hint_other', 'Shift RC · Ctrl Perf')
}

export function getUpdateCheckClickOptions(
  event: UpdateCheckClickEvent,
  isMac = isMacShortcutPlatform()
): UpdateCheckOptions {
  if (isMac && event.altKey) {
    return { localBuild: true }
  }
  return {
    includePrerelease: event.shiftKey,
    includePerfPrerelease: isMac ? event.metaKey : event.ctrlKey
  }
}

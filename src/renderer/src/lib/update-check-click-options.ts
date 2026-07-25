import type { UpdateCheckOptions } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from './shortcut-platform'

type UpdateCheckClickEvent = Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

function isMacShortcutPlatform(): boolean {
  return getShortcutPlatform() === 'darwin'
}

export function getUpdateCheckHint(isMac = isMacShortcutPlatform()): string {
  // Why: only the modifier glyphs are platform-bound; the sentence (including
  // "click") stays translatable as a whole.
  const releaseHints = translate(
    'auto.lib.updateCheckClickOptions.hint',
    '{{value0}}+click checks the latest RC; {{value1}}+click checks the latest perf build.',
    { value0: isMac ? '⇧' : 'Shift', value1: isMac ? '⌘' : 'Ctrl' }
  )
  if (!isMac) {
    return releaseHints
  }
  // Why: the local-build modifier is macOS-only, so it stays a separate
  // sentence rather than a conditional fragment inside the shared string.
  return `${releaseHints} ${translate(
    'auto.lib.updateCheckClickOptions.localBuildHint',
    '{{value0}}+click chooses a local macOS build.',
    { value0: '⌥' }
  )}`
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

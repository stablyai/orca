import type { UpdateCheckOptions } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from './shortcut-platform'

type UpdateCheckClickEvent = Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

function isMacShortcutPlatform(): boolean {
  return getShortcutPlatform() === 'darwin'
}

/**
 * Localized one-liner documenting the modifier-click update channels, for the
 * Settings hint line and the renderer tooltips. `isMac` is injectable so tests
 * can assert both platform variants without stubbing the platform.
 */
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

/**
 * Maps a renderer click's modifier state onto update channel options: Shift
 * selects the latest RC, Cmd (mac) / Ctrl (elsewhere) the latest perf build.
 */
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

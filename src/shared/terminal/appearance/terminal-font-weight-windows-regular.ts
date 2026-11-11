import type { GlobalSettings } from '../../global-settings-types'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from './terminal-fonts'
import { WINDOWS_TERMINAL_FONT_WEIGHT } from './terminal-platform-defaults'

type TerminalFontWeightSettings = Pick<
  GlobalSettings,
  'terminalFontWeight' | 'terminalFontWeightWindowsRegular'
>

/** Moves Windows profiles still on the old 500 default to Regular once. Settings stored the
 * default literally, so a deliberate 500 moves too; the notice lets them switch back. */
export function migrateWindowsTerminalFontWeight(
  settings: Partial<TerminalFontWeightSettings> | undefined,
  platform: string
): Partial<TerminalFontWeightSettings> {
  if (platform !== 'win32' || settings?.terminalFontWeightWindowsRegular !== undefined) {
    return {}
  }
  if (settings?.terminalFontWeight === DEFAULT_TERMINAL_FONT_WEIGHT) {
    return {
      terminalFontWeight: WINDOWS_TERMINAL_FONT_WEIGHT,
      terminalFontWeightWindowsRegular: 'notice-pending'
    }
  }
  return { terminalFontWeightWindowsRegular: 'done' }
}

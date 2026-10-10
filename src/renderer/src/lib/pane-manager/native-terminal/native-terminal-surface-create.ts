import { translate } from '@/i18n/i18n'
import type { NativeTerminalAppearance } from '../../../../../shared/native-terminal-appearance'

// Null when the native view could not be made. VoiceOver names the surface in the UI language
// of its creation, like the pane's other DOM labels.
export function createNativeTerminalSurface(
  api: Window['api']['nativeTerminal'],
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): Promise<number | null> {
  const label = translate('auto.lib.native.terminal.surface.create.accessibilityLabel', 'Terminal')
  return api.create(appearance, zoomFactor, label).catch(() => null)
}

import type { GlobalSettings } from './types'

type TerminalCursorStyleSettings = Pick<
  GlobalSettings,
  'terminalCursorStyle' | 'terminalCursorStyleDefaultedToBlock'
>

export function normalizeTerminalCursorStyleDefault(
  settings: Partial<TerminalCursorStyleSettings> | undefined,
  options: { preserveExplicitValue?: boolean } = {}
): TerminalCursorStyleSettings {
  const defaultedToBlock =
    settings?.terminalCursorStyleDefaultedToBlock === true || options.preserveExplicitValue === true

  return {
    // Why: prior builds persisted the old bar default into profiles; migrate
    // those inherited values once while preserving later explicit choices.
    terminalCursorStyle: defaultedToBlock ? (settings?.terminalCursorStyle ?? 'block') : 'block',
    terminalCursorStyleDefaultedToBlock: true
  }
}

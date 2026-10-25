import type { GlobalSettings } from './global-settings-types'

type TerminalCursorStyleSettings = Pick<
  GlobalSettings,
  'terminalCursorStyle' | 'terminalCursorStyleDefaultedToBlock'
>

function isTerminalCursorStyle(value: unknown): value is GlobalSettings['terminalCursorStyle'] {
  return value === 'bar' || value === 'block' || value === 'underline'
}

export function normalizeTerminalCursorStyleDefault(
  settings: Partial<TerminalCursorStyleSettings> | undefined,
  options: { preserveExplicitValue?: boolean } = {}
): TerminalCursorStyleSettings {
  const defaultedToBlock =
    settings?.terminalCursorStyleDefaultedToBlock === true || options.preserveExplicitValue === true

  return {
    // Migrate the inherited bar default once, preserving later explicit choices.
    terminalCursorStyle:
      defaultedToBlock && isTerminalCursorStyle(settings?.terminalCursorStyle)
        ? settings.terminalCursorStyle
        : 'block',
    terminalCursorStyleDefaultedToBlock: true
  }
}

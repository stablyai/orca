import { DEFAULT_TERMINAL_FONT_WEIGHT } from './terminal-fonts'

// Settings displays this family; buildFontFamily adds the cross-platform fallback chain.
export function defaultTerminalFontFamily(): string {
  const platform = typeof process !== 'undefined' ? process.platform : ''
  if (platform === 'win32') {
    return 'Cascadia Mono'
  }
  if (platform === 'linux') {
    return 'DejaVu Sans Mono'
  }
  return 'SF Mono' // macOS default
}

// Cascadia Mono has no Medium face, so Windows draws 500 as SemiBold; 400 is its real Regular.
export const WINDOWS_TERMINAL_FONT_WEIGHT = 400

export function defaultTerminalFontWeight(
  platform = typeof process !== 'undefined' ? process.platform : ''
): number {
  return platform === 'win32' ? WINDOWS_TERMINAL_FONT_WEIGHT : DEFAULT_TERMINAL_FONT_WEIGHT
}

export const getDefaultPrimarySelectionMiddleClickPaste = (
  platform = typeof process !== 'undefined' ? process.platform : ''
): boolean => platform === 'linux' || platform === 'darwin'

export const getDefaultTerminalRightClickToPaste = (
  platform = typeof process !== 'undefined' ? process.platform : ''
): boolean => platform === 'win32'

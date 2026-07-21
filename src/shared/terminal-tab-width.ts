// Why: the tab strip's shrink floor/ceiling is a taste tradeoff — some users want
// many narrow tabs, others want fewer tabs with readable titles. This enumerates
// the presets so the renderer's flex rules and the settings UI agree on one source.
export const TERMINAL_TAB_WIDTH_HUG = 'hug'
export const TERMINAL_TAB_WIDTH_DEFAULT = 'default'
export const TERMINAL_TAB_WIDTH_LARGE = 'large'
export const TERMINAL_TAB_WIDTH_XLARGE = 'x-large'

export type TerminalTabWidth =
  | typeof TERMINAL_TAB_WIDTH_HUG
  | typeof TERMINAL_TAB_WIDTH_DEFAULT
  | typeof TERMINAL_TAB_WIDTH_LARGE
  | typeof TERMINAL_TAB_WIDTH_XLARGE

export const DEFAULT_TERMINAL_TAB_WIDTH: TerminalTabWidth = TERMINAL_TAB_WIDTH_DEFAULT

export const TERMINAL_TAB_WIDTH_VALUES: readonly TerminalTabWidth[] = [
  TERMINAL_TAB_WIDTH_HUG,
  TERMINAL_TAB_WIDTH_DEFAULT,
  TERMINAL_TAB_WIDTH_LARGE,
  TERMINAL_TAB_WIDTH_XLARGE
]

const TERMINAL_TAB_WIDTH_SET = new Set<TerminalTabWidth>(TERMINAL_TAB_WIDTH_VALUES)

export function normalizeTerminalTabWidth(value: unknown): TerminalTabWidth {
  return TERMINAL_TAB_WIDTH_SET.has(value as TerminalTabWidth)
    ? (value as TerminalTabWidth)
    : DEFAULT_TERMINAL_TAB_WIDTH
}

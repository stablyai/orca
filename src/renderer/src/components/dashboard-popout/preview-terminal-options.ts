import type { ITerminalInitOnlyOptions, ITerminalOptions, ITheme } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import {
  buildDefaultTerminalOptions,
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity,
  resolveTerminalCursorInactiveStyle
} from '@/lib/pane-manager/pane-terminal-options'
import { buildLocalConptyTerminalOptions } from '@/lib/pane-manager/windows-pty-compatibility'
import { buildFontFamily } from '@/components/terminal-pane/layout-serialization'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'

/** Options a live settings change can write onto an open preview terminal. */
export function buildPreviewAppearanceOptions(
  settings: GlobalSettings | null,
  macOptionIsMeta: boolean
): Partial<ITerminalOptions> {
  const cursorStyle = settings?.terminalCursorStyle ?? 'block'
  const fontWeights = resolveTerminalFontWeights(
    settings?.terminalFontWeight,
    settings?.terminalFontWeightBold
  )
  return {
    fontSize: settings?.terminalFontSize ?? 14,
    fontFamily: buildFontFamily(settings?.terminalFontFamily ?? ''),
    fontWeight: fontWeights.fontWeight,
    fontWeightBold: fontWeights.fontWeightBold,
    cursorStyle,
    cursorInactiveStyle: resolveTerminalCursorInactiveStyle(cursorStyle),
    cursorBlink: settings?.terminalCursorBlink ?? true,
    scrollSensitivity: normalizeTerminalScrollSensitivity(settings?.terminalScrollSensitivity),
    fastScrollSensitivity: normalizeTerminalFastScrollSensitivity(
      settings?.terminalFastScrollSensitivity
    ),
    lineHeight: normalizeTerminalLineHeight(settings?.terminalLineHeight),
    wordSeparator: settings?.terminalWordSeparator,
    // Why only 'true': 'left'/'right' are handled by the keydown policy, which needs Option composable at the xterm level.
    macOptionIsMeta,
    // Why: xterm renders an alpha background opaque unless transparency is on (matches applyTerminalAppearance).
    allowTransparency:
      settings?.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1
  }
}

/**
 * Full option set for the preview's xterm: the same defaults, user appearance,
 * and host compatibility flags a pane resolves, so the agent's TUI negotiates
 * with an identically-configured emulator. Scrollback stays preview-sized —
 * main only ever serializes a short history window into this terminal.
 */
export function buildPreviewTerminalOptions(args: {
  settings: GlobalSettings | null
  terminalInput: DashboardCardTerminalInput | null
  macOptionIsMeta: boolean
  theme: ITheme | null
  themeMode: 'dark' | 'light'
  cols: number
  rows: number
  scrollback: number
}): ITerminalOptions & ITerminalInitOnlyOptions {
  const hostCompatibility: Partial<ITerminalOptions> = {
    ...(args.terminalInput?.localWindowsConpty
      ? buildLocalConptyTerminalOptions(args.terminalInput.osRelease)
      : {}),
    // Why: local ConPTY CLIs read the advertisement but can't decode CSI-u (#2434); mirror the pane's withhold.
    ...(args.terminalInput && !args.terminalInput.kittyKeyboardAdvertised
      ? { vtExtensions: { kittyKeyboard: false } }
      : {})
  }
  return {
    ...buildDefaultTerminalOptions(),
    ...buildPreviewAppearanceOptions(args.settings, args.macOptionIsMeta),
    ...hostCompatibility,
    cols: args.cols,
    rows: args.rows,
    scrollback: args.scrollback,
    theme: args.theme ?? undefined,
    minimumContrastRatio: resolveTerminalMinimumContrastRatio(
      args.theme?.background,
      args.themeMode
    )
  }
}

import type { ThemeStudioMode } from '../../../../shared/theme-studio/theme-studio-draft'
import { DEFAULT_TERMINAL_THEMES } from '../../../../shared/terminal-themes/defaults'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT
} from '../../../../shared/terminal-themes/terminal-theme-selection'
import type { TerminalColorOverrides } from '../../../../shared/terminal-themes/terminal-color-overrides'

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
const BRIGHT: Record<(typeof ANSI)[number], keyof TerminalColorOverrides> = {
  black: 'brightBlack',
  red: 'brightRed',
  green: 'brightGreen',
  yellow: 'brightYellow',
  blue: 'brightBlue',
  magenta: 'brightMagenta',
  cyan: 'brightCyan',
  white: 'brightWhite'
}

/** The terminal: the draft's palette over the person's terminal theme for the mode (Orca's
 *  default when unknown), all 16 ANSI colors, a selection and typical colored output. */
export function SpecimenTerminal({
  mode,
  terminal,
  base
}: {
  mode: ThemeStudioMode
  terminal: TerminalColorOverrides | undefined
  base: Readonly<Record<string, string>> | undefined
}): React.JSX.Element {
  const builtIn =
    DEFAULT_TERMINAL_THEMES[
      mode === 'dark' ? DEFAULT_TERMINAL_THEME_DARK : DEFAULT_TERMINAL_THEME_LIGHT
    ]
  const color = (key: keyof TerminalColorOverrides): string | undefined => {
    const fallback: unknown = builtIn?.[key]
    return terminal?.[key] ?? base?.[key] ?? (typeof fallback === 'string' ? fallback : undefined)
  }
  return (
    <div
      className="h-[42%] shrink-0 border-t border-border px-4 py-3 font-mono text-[12.5px] leading-[1.6]"
      style={{ background: color('background'), color: color('foreground') }}
    >
      <div>
        <span style={{ color: color('blue') }}>~/aurora-app</span>{' '}
        <span style={{ color: color('magenta') }}>feature/welcome-back</span> $ npm test
      </div>
      <div>
        <span style={{ color: color('green') }}>✓ 42 passed</span>{' '}
        <span style={{ color: color('yellow') }}>○ 1 skipped</span>{' '}
        <span style={{ color: color('red') }}>✗ 0 failed</span>
      </div>
      <div>
        <span style={{ color: color('cyan') }}>➜</span> Local:{' '}
        <span style={{ color: color('cyan') }}>http://localhost:5173/</span>
      </div>
      <div className="mt-2 grid grid-cols-8 gap-1">
        {ANSI.map((key) => (
          <span key={key} className="h-3 rounded-sm" style={{ background: color(key) }} />
        ))}
        {ANSI.map((key) => (
          <span key={key} className="h-3 rounded-sm" style={{ background: color(BRIGHT[key]) }} />
        ))}
      </div>
      <div className="mt-2">
        <span
          style={{
            background: color('selectionBackground'),
            color: color('selectionForeground') ?? color('foreground')
          }}
        >
          selected text
        </span>{' '}
        <span style={{ color: color('brightBlack') }}>dim note</span>{' '}
        <span
          style={{
            background: color('cursor'),
            color: color('cursorAccent') ?? color('background')
          }}
        >
          {' '}
        </span>
      </div>
    </div>
  )
}

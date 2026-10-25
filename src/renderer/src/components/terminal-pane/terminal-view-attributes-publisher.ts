/** Publish xterm-equivalent theme reply attributes to main’s hidden-PTY responder; module-global dedup avoids repeated sends from per-pane/attribute-neutral appearance updates. */
import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import {
  terminalViewColorQueryReplyColors,
  type TerminalViewAttributes,
  type TerminalViewRgb
} from '../../../../shared/terminal-view-attributes'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'

type ParsedCssColor = {
  rgb: TerminalViewRgb
  /** 0-255, the precision xterm stores (rgba byte) — blend parity needs it. */
  alpha: number
}

// Mirror ThemeService fg/bg/cursor defaults.
const DEFAULT_FOREGROUND: ParsedCssColor = { rgb: [0xff, 0xff, 0xff], alpha: 0xff }
const DEFAULT_BACKGROUND: ParsedCssColor = { rgb: [0x00, 0x00, 0x00], alpha: 0xff }
const DEFAULT_CURSOR: ParsedCssColor = { rgb: [0xff, 0xff, 0xff], alpha: 0xff }

// xterm's DEFAULT_ANSI_COLORS first 16 entries (browser/Types.ts).
const DEFAULT_ANSI_16: readonly string[] = [
  '#2e3436',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf',
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec'
]

const THEME_ANSI_KEYS: readonly (keyof ITheme)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

function buildDefaultAnsiPalette(): TerminalViewRgb[] {
  const palette = DEFAULT_ANSI_16.map((hex) => parseThemeColor(hex, DEFAULT_BACKGROUND).rgb)
  // Match xterm’s generated 6×6×6 cube and grey tail for untouched palette entries.
  const v = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
  for (let i = 0; i < 216; i++) {
    palette.push([v[((i / 36) % 6) | 0], v[((i / 6) % 6) | 0], v[i % 6]])
  }
  for (let i = 0; i < 24; i++) {
    const c = 8 + i * 10
    palette.push([c, c, c])
  }
  return palette
}

const DEFAULT_ANSI_PALETTE: readonly TerminalViewRgb[] = buildDefaultAnsiPalette()

/** Mirror xterm’s hex/rgb[a] fast paths used by first-party themes. Named/modern CSS needs canvas and falls back here, unlike visible xterm. */
export function parseCssColor(css: string): ParsedCssColor | null {
  if (/^#[\da-f]{3,8}$/i.test(css)) {
    switch (css.length) {
      case 4:
        return {
          rgb: [
            Number.parseInt(css.slice(1, 2).repeat(2), 16),
            Number.parseInt(css.slice(2, 3).repeat(2), 16),
            Number.parseInt(css.slice(3, 4).repeat(2), 16)
          ],
          alpha: 0xff
        }
      case 5:
        return {
          rgb: [
            Number.parseInt(css.slice(1, 2).repeat(2), 16),
            Number.parseInt(css.slice(2, 3).repeat(2), 16),
            Number.parseInt(css.slice(3, 4).repeat(2), 16)
          ],
          alpha: Number.parseInt(css.slice(4, 5).repeat(2), 16)
        }
      case 7:
        return {
          rgb: [
            Number.parseInt(css.slice(1, 3), 16),
            Number.parseInt(css.slice(3, 5), 16),
            Number.parseInt(css.slice(5, 7), 16)
          ],
          alpha: 0xff
        }
      case 9:
        return {
          rgb: [
            Number.parseInt(css.slice(1, 3), 16),
            Number.parseInt(css.slice(3, 5), 16),
            Number.parseInt(css.slice(5, 7), 16)
          ],
          alpha: Number.parseInt(css.slice(7, 9), 16)
        }
      default:
        return null
    }
  }
  const rgbaMatch = css.match(
    /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|\d?\.(\d+))\s*)?\)/
  )
  if (rgbaMatch) {
    return {
      rgb: [
        Number.parseInt(rgbaMatch[1], 10),
        Number.parseInt(rgbaMatch[2], 10),
        Number.parseInt(rgbaMatch[3], 10)
      ],
      alpha: Math.round((rgbaMatch[5] === undefined ? 1 : Number.parseFloat(rgbaMatch[5])) * 0xff)
    }
  }
  return null
}

function parseThemeColor(css: string | undefined, fallback: ParsedCssColor): ParsedCssColor {
  if (css !== undefined) {
    const parsed = parseCssColor(css)
    if (parsed) {
      return parsed
    }
  }
  return fallback
}

// ThemeService blends cursor alpha over background before OSC 12 replies; match its byte-rounded blend.
function blendOverBackground(background: TerminalViewRgb, color: ParsedCssColor): TerminalViewRgb {
  if (color.alpha === 0xff) {
    return color.rgb
  }
  const a = color.alpha / 0xff
  return [
    background[0] + Math.round((color.rgb[0] - background[0]) * a),
    background[1] + Math.round((color.rgb[1] - background[1]) * a),
    background[2] + Math.round((color.rgb[2] - background[2]) * a)
  ]
}

export function composeTerminalViewAttributes(
  theme: ITheme | null,
  mode: TerminalColorSchemeMode,
  settings: Pick<GlobalSettings, 'terminalCursorStyle' | 'terminalCursorBlink'>
): TerminalViewAttributes {
  const foreground = parseThemeColor(theme?.foreground, DEFAULT_FOREGROUND)
  const background = parseThemeColor(theme?.background, DEFAULT_BACKGROUND)
  const cursor = parseThemeColor(theme?.cursor, DEFAULT_CURSOR)
  const ansi: TerminalViewRgb[] = THEME_ANSI_KEYS.map((key, i) => {
    const value = theme?.[key]
    return parseThemeColor(typeof value === 'string' ? value : undefined, {
      rgb: DEFAULT_ANSI_PALETTE[i],
      alpha: 0xff
    }).rgb
  })
  for (let i = 16; i < DEFAULT_ANSI_PALETTE.length; i++) {
    const extended = theme?.extendedAnsi?.[i - 16]
    ansi.push(
      parseThemeColor(extended, {
        rgb: DEFAULT_ANSI_PALETTE[i],
        alpha: 0xff
      }).rgb
    )
  }
  return {
    foreground: foreground.rgb,
    background: background.rgb,
    cursor: blendOverBackground(background.rgb, cursor),
    ansi,
    colorSchemeMode: mode,
    // Same resolution as the per-pane option writes in applyTerminalAppearance.
    cursorStyle: settings.terminalCursorStyle ?? 'block',
    cursorBlink: settings.terminalCursorBlink === true
  }
}

let lastPublishedSnapshot: string | null = null
let lastPublishedColors: TerminalOscColorQueryReplyColors | null = null
type PublishedColorsListener = (colors: TerminalOscColorQueryReplyColors) => void
const publishedColorsListeners = new Set<PublishedColorsListener>()

/** Hears the fg/bg of every published change, starting with the current one if any. */
export function subscribeToPublishedTerminalViewColors(
  listener: PublishedColorsListener
): () => void {
  publishedColorsListeners.add(listener)
  if (lastPublishedColors) {
    listener(lastPublishedColors)
  }
  return () => {
    publishedColorsListeners.delete(listener)
  }
}

function sendViaPreload(attributes: TerminalViewAttributes): boolean {
  // Preload is absent in web/tests; remote-runtime PTYs never use main’s hidden gate.
  if (typeof window === 'undefined' || !window.api?.pty?.publishTerminalViewAttributes) {
    return false
  }
  window.api.pty.publishTerminalViewAttributes(attributes)
  return true
}

/** Deduplicate app-global snapshots across pane applies and attribute-neutral settings changes. */
export function publishTerminalViewAttributes(
  theme: ITheme | null,
  mode: TerminalColorSchemeMode,
  settings: Pick<GlobalSettings, 'terminalCursorStyle' | 'terminalCursorBlink'>,
  send: (attributes: TerminalViewAttributes) => boolean = sendViaPreload
): boolean {
  const attributes = composeTerminalViewAttributes(theme, mode, settings)
  const serialized = JSON.stringify(attributes)
  if (serialized === lastPublishedSnapshot) {
    return false
  }
  if (!send(attributes)) {
    // Not recorded: a later call with a working bridge must still publish.
    return false
  }
  lastPublishedSnapshot = serialized
  const colors = terminalViewColorQueryReplyColors(attributes)
  lastPublishedColors = colors
  for (const listener of publishedColorsListeners) {
    listener(colors)
  }
  return true
}

export function _resetTerminalViewAttributesPublisherForTest(): void {
  lastPublishedSnapshot = null
  lastPublishedColors = null
  publishedColorsListeners.clear()
}

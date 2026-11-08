import type { ITheme } from '@xterm/xterm'
import { contrastRatio, over, type Rgba } from '../color/rgba-contrast'
import { resolveOpaqueTerminalBackground } from './terminal-title-contrast'

// Why 3:1: a focus ring or cursor must stand out; the shared gate's 2:1 is only its floor.
const MIN_TERMINAL_ACCENT_CONTRAST = 3

export type TerminalPaletteRgba = {
  background: Rgba
  foreground: Rgba
  /** A palette color painted over the background; null when the palette lacks it. */
  color: (key: keyof ITheme) => Rgba | null
  /** Blue, else bright blue, when it stands out on the background. */
  accent: Rgba | undefined
}

/** The terminal palette as the opaque colors it paints; null without a readable background or foreground. */
export function terminalPaletteRgba(
  palette: ITheme | null,
  probe: (value: string) => Rgba | null
): TerminalPaletteRgba | null {
  const opaqueBackground = resolveOpaqueTerminalBackground(palette?.background)
  const background = opaqueBackground ? probe(opaqueBackground) : null
  const rawForeground = palette?.foreground ? probe(palette.foreground) : null
  if (!palette || !background || !rawForeground) {
    return null
  }
  const color = (key: keyof ITheme): Rgba | null => {
    const value = palette[key]
    const parsed = typeof value === 'string' ? probe(value) : null
    return parsed ? over(parsed, background) : null
  }
  const accent = [color('blue'), color('brightBlue')].find(
    (candidate): candidate is Rgba =>
      candidate !== null && contrastRatio(candidate, background) >= MIN_TERMINAL_ACCENT_CONTRAST
  )
  return { background, foreground: over(rawForeground, background), color, accent }
}

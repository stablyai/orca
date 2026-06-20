type RgbaColor = { r: number; g: number; b: number; a: number }

const APP_SURFACE_COLORS: Record<'dark' | 'light', RgbaColor> = {
  dark: { r: 10, g: 10, b: 10, a: 1 },
  light: { r: 255, g: 255, b: 255, a: 1 }
}

const NAMED_TERMINAL_BACKGROUND_COLORS: Record<string, RgbaColor> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 }
}

const LIGHT_SURFACE_CONTRAST_REFERENCE = { r: 0, g: 0, b: 0 }
const DARK_SURFACE_CONTRAST_REFERENCE = { r: 255, g: 255, b: 255 }

export function isTerminalBackgroundLight(
  background: string | undefined,
  options: { backgroundOpacity?: number; appSurface?: 'dark' | 'light' } = {}
): boolean {
  const color = parseCssRgbColor(background)
  if (!color) {
    return false
  }

  // Why: transparent terminal backgrounds visually blend with the app surface,
  // so title contrast has to classify the composited color, not just the theme.
  const alpha = clampNumber(color.a * (options.backgroundOpacity ?? 1), 0, 1)
  const appSurface = APP_SURFACE_COLORS[options.appSurface ?? 'dark']
  const composited = alpha < 1 ? compositeRgb(color, appSurface, alpha) : color

  return (
    contrastRatio(LIGHT_SURFACE_CONTRAST_REFERENCE, composited) >=
    contrastRatio(DARK_SURFACE_CONTRAST_REFERENCE, composited)
  )
}

function parseCssRgbColor(color: string | undefined): RgbaColor | null {
  const value = color?.trim().toLowerCase()
  if (!value) {
    return null
  }

  const named = NAMED_TERMINAL_BACKGROUND_COLORS[value]
  if (named) {
    return named
  }

  const hexMatch = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hexMatch) {
    const hex = hexMatch[1]
    const channels =
      hex.length === 3 || hex.length === 4
        ? hex
            .slice(0, hex.length === 3 ? 3 : 4)
            .split('')
            .map((part) => Number.parseInt(part + part, 16))
        : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)]
            .filter((part) => part.length > 0)
            .map((part) => Number.parseInt(part, 16))
    return {
      r: channels[0],
      g: channels[1],
      b: channels[2],
      a: channels[3] === undefined ? 1 : channels[3] / 255
    }
  }

  const rgbMatch = value.match(/^rgba?\((.+)\)$/)
  if (!rgbMatch) {
    return null
  }

  const parts = rgbMatch[1].includes(',')
    ? rgbMatch[1].split(',').map((part) => part.trim())
    : getCssRgbFunctionWhitespaceParts(rgbMatch[1], 4)
  if (parts.length < 3) {
    return null
  }
  const channels = parts.slice(0, 3).map(parseCssRgbChannel)
  if (channels.some((channel) => channel === null)) {
    return null
  }
  const alpha = parts[3] === undefined ? 1 : parseCssAlpha(parts[3])
  if (alpha === null) {
    return null
  }
  return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: alpha }
}

// Why: imported terminal themes can supply modern rgb() syntax; keep this
// render-path parser from allocating regex split arrays.
function getCssRgbFunctionWhitespaceParts(body: string, maxParts: number): string[] {
  const parts: string[] = []
  let tokenStart = -1

  for (let index = 0; index <= body.length; index += 1) {
    const isEnd = index === body.length
    if (!isEnd && !isCssRgbFunctionWhitespaceSeparator(body.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index
      }
      continue
    }
    if (tokenStart !== -1) {
      parts.push(body.slice(tokenStart, index))
      tokenStart = -1
      if (parts.length >= maxParts) {
        break
      }
    }
  }

  return parts
}

function isCssRgbFunctionWhitespaceSeparator(code: number): boolean {
  return (
    code === 47 ||
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

function parseCssRgbChannel(channel: string): number | null {
  const trimmed = channel.trim()
  const value = trimmed.endsWith('%')
    ? (Number.parseFloat(trimmed.slice(0, -1)) / 100) * 255
    : Number.parseFloat(trimmed)
  if (!Number.isFinite(value)) {
    return null
  }
  return Math.min(255, Math.max(0, Math.round(value)))
}

function parseCssAlpha(alpha: string): number | null {
  const trimmed = alpha.trim()
  const value = trimmed.endsWith('%')
    ? Number.parseFloat(trimmed.slice(0, -1)) / 100
    : Number.parseFloat(trimmed)
  if (!Number.isFinite(value)) {
    return null
  }
  return clampNumber(value, 0, 1)
}

function compositeRgb(foreground: RgbaColor, background: RgbaColor, alpha: number): RgbaColor {
  return {
    r: Math.round(foreground.r * alpha + background.r * (1 - alpha)),
    g: Math.round(foreground.g * alpha + background.g * (1 - alpha)),
    b: Math.round(foreground.b * alpha + background.b * (1 - alpha)),
    a: 1
  }
}

function relativeLuminance(rgb: Pick<RgbaColor, 'r' | 'g' | 'b'>): number {
  const toLinear = (channel: number): number => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b)
}

function contrastRatio(
  foreground: Pick<RgbaColor, 'r' | 'g' | 'b'>,
  background: Pick<RgbaColor, 'r' | 'g' | 'b'>
): number {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

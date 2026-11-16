/** sRGB channels 0-255 and alpha 0-1. */
export type Rgba = readonly [number, number, number, number]

const BLACK: Rgba = [0, 0, 0, 1]
const WHITE: Rgba = [255, 255, 255, 1]

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two opaque colors. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const first = luminance(a)
  const second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

/** `color-mix(in srgb, a percent%, b)`. */
export function mix(a: Rgba, b: Rgba, percent: number): Rgba {
  const p = percent / 100
  const channel = (index: 0 | 1 | 2 | 3): number => a[index] * p + b[index] * (1 - p)
  return [channel(0), channel(1), channel(2), channel(3)]
}

/** Pushes a color toward black or white until it reads on every surface, so low-contrast
 *  palettes (Solarized) keep their hue instead of losing the color to a contrast gate. */
export function readableOn(
  color: Rgba,
  surfaces: readonly Rgba[],
  light: boolean,
  minimum: number
): Rgba {
  const extreme = light ? BLACK : WHITE
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mix(extreme, color, (step / 20) * 100)
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= minimum)) {
      return candidate
    }
  }
  return extreme
}

export function hexToRgb(hex: string): Rgba {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return [r, g, b, 1]
}

export function rgbaToHex([r, g, b]: Rgba): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

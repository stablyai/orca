// A picture's tint for surfaces that take the avatar's color (the New bot dialog's band): the color of its
// background, read once from the outer ring as it is taken in, so the subject in the middle doesn't sway it.

/** The ring sampled, as a share of the side. */
const RING = 0.1
// Coarse bins (4 bits a channel) keep anti-aliasing and noise from splitting the background's color.
const BIN_SHIFT = 4
// A soft band in both themes: never near-black, near-white or loud.
const MIN_LIGHTNESS = 0.35
const MAX_LIGHTNESS = 0.8
const MAX_SATURATION = 0.6

/** The most common color of the outer ring of `side`×`side` RGBA pixels, toned down; null when the ring
 *  is mostly transparent. */
export function pictureTint(pixels: Uint8ClampedArray, side: number): string | null {
  const ring = Math.max(1, Math.round(side * RING))
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
  let sampled = 0
  let opaque = 0
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      if (Math.min(x, y, side - 1 - x, side - 1 - y) >= ring) {
        continue
      }
      sampled += 1
      const i = (y * side + x) * 4
      if (pixels[i + 3] < 128) {
        continue
      }
      opaque += 1
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]
      const key = ((r >> BIN_SHIFT) << 8) | ((g >> BIN_SHIFT) << 4) | (b >> BIN_SHIFT)
      const bin = bins.get(key)
      if (bin) {
        bin.n += 1
        bin.r += r
        bin.g += g
        bin.b += b
      } else {
        bins.set(key, { n: 1, r, g, b })
      }
    }
  }
  if (opaque * 2 < sampled) {
    return null
  }
  let top = { n: 0, r: 0, g: 0, b: 0 }
  for (const bin of bins.values()) {
    if (bin.n > top.n) {
      top = bin
    }
  }
  return toned(top.r / top.n, top.g / top.n, top.b / top.n)
}

function toned(r: number, g: number, b: number): string {
  const [h, s, l] = toHsl(r / 255, g / 255, b / 255)
  return toHex(h, Math.min(s, MAX_SATURATION), Math.min(Math.max(l, MIN_LIGHTNESS), MAX_LIGHTNESS))
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) {
    return [0, 0, l]
  }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6
  return [h, s, l]
}

function toHex(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): string => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    const v =
      u < 1 / 6
        ? p + (q - p) * 6 * u
        : u < 1 / 2
          ? q
          : u < 2 / 3
            ? p + (q - p) * (2 / 3 - u) * 6
            : p
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(h + 1 / 3)}${channel(h)}${channel(h - 1 / 3)}`
}

// Tints by the picture's PNG, newest last; a picture taken in this session finds its tint here.
const MAX_TINTS = 20
const tints = new Map<string, string | null>()

export function rememberPictureTint(png: string, tint: string | null): void {
  tints.delete(png)
  tints.set(png, tint)
  const oldest = tints.keys().next()
  if (tints.size > MAX_TINTS && !oldest.done) {
    tints.delete(oldest.value)
  }
}

/** The tint read when `png` was taken in; null when it has none or was not taken in this session. */
export function pictureTintFor(png: string | null | undefined): string | null {
  return png ? (tints.get(png) ?? null) : null
}

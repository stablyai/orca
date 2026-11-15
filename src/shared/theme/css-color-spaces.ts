// Color-space conversions to gamma-encoded sRGB (0-1), per CSS Color 4.

export const toLinear = (c: number): number =>
  Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4
export const fromLinear = (c: number): number =>
  Math.abs(c) <= 0.0031308 ? 12.92 * c : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055)

export function oklabToSrgb(l: number, a: number, b: number): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    fromLinear(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    fromLinear(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    fromLinear(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)
  ]
}

export function srgbToOklab([r, g, b]: readonly number[]): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

/** CIE Lab (D50) to sRGB through XYZ, adapted to D65 with Bradford. */
export function labToSrgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const e = 216 / 24389
  const k = 24389 / 27
  const x = ((fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * 0.3457) / 0.3585
  const y = l > k * e ? fy ** 3 : l / k
  const z = ((fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * (1 - 0.3457 - 0.3585)) / 0.3585
  const xd = 0.9554734527042182 * x - 0.023098536874261423 * y + 0.0632593086610217 * z
  const yd = -0.028369706963208136 * x + 1.0099954580058226 * y + 0.021041398966943008 * z
  const zd = 0.012314001688319899 * x - 0.020507696433477912 * y + 1.3303659366080753 * z
  return [
    fromLinear(3.2409699419045226 * xd - 1.537383177570094 * yd - 0.4986107602930034 * zd),
    fromLinear(-0.9692436362808796 * xd + 1.8759675015077202 * yd + 0.04155505740717559 * zd),
    fromLinear(0.05563007969699366 * xd - 0.20397695888897652 * yd + 1.0569715142428786 * zd)
  ]
}

export function displayP3ToSrgb(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  return [
    fromLinear(1.2249401 * lr - 0.2249404 * lg),
    fromLinear(-0.0420569 * lr + 1.0420571 * lg),
    fromLinear(-0.0196376 * lr - 0.0786361 * lg + 1.0982735 * lb)
  ]
}

export function hslToSrgb(h: number, s: number, l: number): [number, number, number] {
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [channel(0), channel(8), channel(4)]
}

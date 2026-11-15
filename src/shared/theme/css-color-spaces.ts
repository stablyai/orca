// Color spaces of CSS Color 4, converted to and from gamma-encoded sRGB (0-1, unclipped), with the
// coordinate conventions CSS uses: hsl/hwb in degrees and 0-100, lab/lch L 0-100, oklab/oklch
// L 0-1. Matrices are the ones the CSS Color 4 sample code publishes.

export type Vec3 = [number, number, number]
type Matrix = readonly [Vec3, Vec3, Vec3]

const multiply = (m: Matrix, [x, y, z]: readonly number[]): Vec3 => [
  m[0][0] * x + m[0][1] * y + m[0][2] * z,
  m[1][0] * x + m[1][1] * y + m[1][2] * z,
  m[2][0] * x + m[2][1] * y + m[2][2] * z
]

export const toLinear = (c: number): number =>
  Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4
export const fromLinear = (c: number): number =>
  Math.abs(c) <= 0.0031308 ? 12.92 * c : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055)

const SRGB_TO_XYZ: Matrix = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607]
]
const XYZ_TO_SRGB: Matrix = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786]
]
const D65_TO_D50: Matrix = [
  [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
  [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
  [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008]
]
const D50_TO_D65: Matrix = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753]
]
const P3_TO_XYZ: Matrix = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976]
]
const REC2020_TO_XYZ: Matrix = [
  [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0, 0.028072693049087428, 1.060985057710791]
]
const A98_TO_XYZ: Matrix = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388]
]
const PROPHOTO_TO_XYZ_D50: Matrix = [
  [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
  [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
  [0, 0, 0.8251046025104601]
]

const signed = (c: number, f: (v: number) => number): number => Math.sign(c) * f(Math.abs(c))
const rec2020ToLinear = (c: number): number =>
  signed(c, (v) =>
    v < 0.018053968510807 * 4.5
      ? v / 4.5
      : ((v + 0.09929682680944) / 1.09929682680944) ** (1 / 0.45)
  )
const a98ToLinear = (c: number): number => signed(c, (v) => v ** (563 / 256))
const prophotoToLinear = (c: number): number =>
  signed(c, (v) => (v <= 16 / 512 ? v / 16 : v ** 1.8))

const WHITE_D50: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585]
const LAB_E = 216 / 24389
const LAB_K = 24389 / 27

function labToXyzD50([l, a, b]: readonly number[]): Vec3 {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  return [
    (fx ** 3 > LAB_E ? fx ** 3 : (116 * fx - 16) / LAB_K) * WHITE_D50[0],
    l > LAB_K * LAB_E ? fy ** 3 : l / LAB_K,
    (fz ** 3 > LAB_E ? fz ** 3 : (116 * fz - 16) / LAB_K) * WHITE_D50[2]
  ]
}

function xyzD50ToLab(xyz: readonly number[]): Vec3 {
  const [fx, fy, fz] = xyz.map((value, index) => {
    const t = value / WHITE_D50[index]
    return t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116
  })
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const LMS_TO_OKLAB: Matrix = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766]
]
const LINEAR_SRGB_TO_LMS: Matrix = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005]
]
const OKLAB_TO_LMS: Matrix = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548]
]
const LMS_TO_LINEAR_SRGB: Matrix = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701]
]

const linearSrgb = (rgb: readonly number[]): Vec3 => [
  toLinear(rgb[0]),
  toLinear(rgb[1]),
  toLinear(rgb[2])
]
const gammaSrgb = (linear: readonly number[]): Vec3 => [
  fromLinear(linear[0]),
  fromLinear(linear[1]),
  fromLinear(linear[2])
]

function toPolar([l, a, b]: readonly number[], epsilon: number): Vec3 {
  const chroma = Math.hypot(a, b)
  // Why NaN: an achromatic color's hue is powerless, which color-mix treats as missing.
  const hue = chroma <= epsilon ? Number.NaN : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  return [l, chroma, hue]
}

function fromPolar([l, c, h]: readonly number[]): Vec3 {
  const hue = Number.isNaN(h) ? 0 : (h * Math.PI) / 180
  return [l, c * Math.cos(hue), c * Math.sin(hue)]
}

export function hslToSrgb([h, s, l]: readonly number[]): Vec3 {
  const hue = Number.isNaN(h) ? 0 : ((h % 360) + 360) % 360
  const [sat, light] = [s / 100, l / 100]
  const channel = (n: number): number => {
    const k = (n + hue / 30) % 12
    return light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [channel(0), channel(8), channel(4)]
}

function srgbToHsl([r, g, b]: readonly number[]): Vec3 {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = Number.NaN
  let s = 0
  if (d !== 0) {
    s = l === 0 || l === 1 ? 0 : (max - l) / Math.min(l, 1 - l)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
  }
  return [h, s * 100, l * 100]
}

export function hwbToSrgb([h, w, b]: readonly number[]): Vec3 {
  const [white, black] = [w / 100, b / 100]
  if (white + black >= 1) {
    const gray = white / (white + black)
    return [gray, gray, gray]
  }
  const [r, g, bl] = hslToSrgb([h, 100, 50])
  const tint = (c: number): number => c * (1 - white - black) + white
  return [tint(r), tint(g), tint(bl)]
}

function srgbToHwb(rgb: readonly number[]): Vec3 {
  const white = Math.min(...rgb)
  const black = 1 - Math.max(...rgb)
  const hue = white + black >= 1 ? Number.NaN : srgbToHsl(rgb)[0]
  return [hue, white * 100, black * 100]
}

/** Spaces a color can be written in or mixed in; `polar` ones interpolate their hue (index). */
export const CSS_COLOR_SPACES = {
  srgb: { from: (c: readonly number[]): Vec3 => [c[0], c[1], c[2]], to: (rgb: Vec3) => rgb },
  'srgb-linear': { from: gammaSrgb, to: linearSrgb },
  'display-p3': {
    from: (c: readonly number[]) =>
      gammaSrgb(multiply(XYZ_TO_SRGB, multiply(P3_TO_XYZ, linearSrgb(c)))),
    to: (rgb: Vec3) =>
      gammaSrgb(
        multiply(
          [
            [2.493496911941425, -0.9313836179191239, -0.40271078445071684],
            [-0.8294889695615747, 1.7626640603183463, 0.023624685841943577],
            [0.03584583024378447, -0.07617238926804182, 0.9568845240076872]
          ],
          multiply(SRGB_TO_XYZ, linearSrgb(rgb))
        )
      )
  },
  rec2020: {
    from: (c: readonly number[]) =>
      gammaSrgb(multiply(XYZ_TO_SRGB, multiply(REC2020_TO_XYZ, c.map(rec2020ToLinear)))),
    to: null
  },
  'a98-rgb': {
    from: (c: readonly number[]) =>
      gammaSrgb(multiply(XYZ_TO_SRGB, multiply(A98_TO_XYZ, c.map(a98ToLinear)))),
    to: null
  },
  'prophoto-rgb': {
    from: (c: readonly number[]) =>
      gammaSrgb(
        multiply(
          XYZ_TO_SRGB,
          multiply(D50_TO_D65, multiply(PROPHOTO_TO_XYZ_D50, c.map(prophotoToLinear)))
        )
      ),
    to: null
  },
  xyz: {
    from: (c: readonly number[]) => gammaSrgb(multiply(XYZ_TO_SRGB, c)),
    to: (rgb: Vec3) => multiply(SRGB_TO_XYZ, linearSrgb(rgb))
  },
  'xyz-d65': {
    from: (c: readonly number[]) => gammaSrgb(multiply(XYZ_TO_SRGB, c)),
    to: (rgb: Vec3) => multiply(SRGB_TO_XYZ, linearSrgb(rgb))
  },
  'xyz-d50': {
    from: (c: readonly number[]) => gammaSrgb(multiply(XYZ_TO_SRGB, multiply(D50_TO_D65, c))),
    to: (rgb: Vec3) => multiply(D65_TO_D50, multiply(SRGB_TO_XYZ, linearSrgb(rgb)))
  },
  lab: {
    from: (c: readonly number[]) =>
      gammaSrgb(multiply(XYZ_TO_SRGB, multiply(D50_TO_D65, labToXyzD50(c)))),
    to: (rgb: Vec3) => xyzD50ToLab(multiply(D65_TO_D50, multiply(SRGB_TO_XYZ, linearSrgb(rgb))))
  },
  lch: {
    from: (c: readonly number[]) => CSS_COLOR_SPACES.lab.from(fromPolar(c)),
    to: (rgb: Vec3) => toPolar(CSS_COLOR_SPACES.lab.to(rgb), 0.0015),
    hue: 2
  },
  oklab: {
    from: (c: readonly number[]) =>
      gammaSrgb(
        multiply(
          LMS_TO_LINEAR_SRGB,
          multiply(OKLAB_TO_LMS, c).map((v) => v ** 3)
        )
      ),
    to: (rgb: Vec3) =>
      multiply(LMS_TO_OKLAB, multiply(LINEAR_SRGB_TO_LMS, linearSrgb(rgb)).map(Math.cbrt))
  },
  oklch: {
    from: (c: readonly number[]) => CSS_COLOR_SPACES.oklab.from(fromPolar(c)),
    to: (rgb: Vec3) => toPolar(CSS_COLOR_SPACES.oklab.to(rgb), 0.000004),
    hue: 2
  },
  hsl: { from: hslToSrgb, to: srgbToHsl, hue: 0 },
  hwb: { from: hwbToSrgb, to: srgbToHwb, hue: 0 }
} as const satisfies Record<
  string,
  { from: (c: readonly number[]) => Vec3; to: ((rgb: Vec3) => Vec3) | null; hue?: number }
>

export type CssColorSpace = keyof typeof CSS_COLOR_SPACES

import {
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN,
  TERMINAL_FONT_WEIGHT_STEP,
  clusterTerminalFontFaces,
  type TerminalFontWeightRaster
} from '../../../shared/terminal-fonts'

const SAMPLE = '0123456789 abcdefghij'
const SAMPLE_SIZE_PX = 28
const faceCache = new Map<string, number[]>()

function rasterizeTerminalFontWeight(
  fontFamily: string,
  weight: number
): TerminalFontWeightRaster | null {
  if (typeof document === 'undefined') {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = 800
  canvas.height = 80
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return null
  }

  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#fff'
  context.font = `${weight} ${SAMPLE_SIZE_PX}px ${fontFamily}`
  context.textBaseline = 'top'
  context.fillText(SAMPLE, 8, 8)
  const advance = context.measureText(SAMPLE).width
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  let ink = 0
  let sum = 0
  for (let index = 0; index < pixels.length; index += 4) {
    const value = pixels[index] ?? 0
    if (value > 0) {
      ink += 1
      sum += value
    }
  }

  return { weight, ink, sum, advance }
}

/** Distinct CSS weights the family can actually rasterize. Empty when unknown. */
export function probeTerminalFontFaces(fontFamily: string): number[] {
  const cached = faceCache.get(fontFamily)
  if (cached) {
    return cached
  }

  const rasters: TerminalFontWeightRaster[] = []
  for (
    let weight = TERMINAL_FONT_WEIGHT_MIN;
    weight <= TERMINAL_FONT_WEIGHT_MAX;
    weight += TERMINAL_FONT_WEIGHT_STEP
  ) {
    const raster = rasterizeTerminalFontWeight(fontFamily, weight)
    if (raster) {
      rasters.push(raster)
    }
  }

  // Why: document.fonts.check() is a fallback oracle, not a presence test.
  // One all-zero cluster (jsdom/happy-dom) is not a real face table.
  const faces = rasters.some((raster) => raster.ink > 0) ? clusterTerminalFontFaces(rasters) : []
  const usableFaces = faces.length >= 2 ? faces : []
  faceCache.set(fontFamily, usableFaces)
  return usableFaces
}

export function clearTerminalFontFaceProbeCache(): void {
  faceCache.clear()
}

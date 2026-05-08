// Why: pet bundles often ship a sprite sheet without manifest frame data, so
// we can't grid-step it. The sheets we see in the wild leave magenta (chroma
// keyed in sidekick-blob-cache) or transparent gutters between sprites.
// After keying, find connected non-empty rows → bands; within the best band,
// split on empty columns to get one frame per sprite. The result drives the
// canvas-based animation in the overlay.

export type DetectedFrame = { x: number; y: number; w: number; h: number }
export type DetectedSprite = { frames: DetectedFrame[] }

const ALPHA_EMPTY = 16
const MIN_DIM = 8

function isPixelEmpty(data: Uint8ClampedArray, idx: number): boolean {
  return data[idx + 3] < ALPHA_EMPTY
}

function computeRowEmpty(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rowEmpty = new Uint8Array(height)
  for (let y = 0; y < height; y++) {
    let empty = 1
    const rowStart = y * width * 4
    for (let x = 0; x < width; x++) {
      if (!isPixelEmpty(data, rowStart + x * 4)) {
        empty = 0
        break
      }
    }
    rowEmpty[y] = empty
  }
  return rowEmpty
}

function findBands(rowEmpty: Uint8Array): { y0: number; y1: number }[] {
  const bands: { y0: number; y1: number }[] = []
  let start = -1
  for (let y = 0; y < rowEmpty.length; y++) {
    if (!rowEmpty[y] && start < 0) {
      start = y
    } else if (rowEmpty[y] && start >= 0) {
      bands.push({ y0: start, y1: y - 1 })
      start = -1
    }
  }
  if (start >= 0) {
    bands.push({ y0: start, y1: rowEmpty.length - 1 })
  }
  return bands
}

function framesInBand(
  data: Uint8ClampedArray,
  width: number,
  band: { y0: number; y1: number }
): DetectedFrame[] {
  const colEmpty = new Uint8Array(width)
  for (let x = 0; x < width; x++) {
    let empty = 1
    for (let y = band.y0; y <= band.y1; y++) {
      if (!isPixelEmpty(data, (y * width + x) * 4)) {
        empty = 0
        break
      }
    }
    colEmpty[x] = empty
  }
  const frames: DetectedFrame[] = []
  let start = -1
  for (let x = 0; x < width; x++) {
    if (!colEmpty[x] && start < 0) {
      start = x
    } else if (colEmpty[x] && start >= 0) {
      frames.push({ x: start, y: band.y0, w: x - start, h: band.y1 - band.y0 + 1 })
      start = -1
    }
  }
  if (start >= 0) {
    frames.push({ x: start, y: band.y0, w: width - start, h: band.y1 - band.y0 + 1 })
  }
  return frames.filter((f) => f.w >= MIN_DIM && f.h >= MIN_DIM)
}

export function detectFramesFromImageData(image: ImageData): DetectedSprite | null {
  const { data, width, height } = image
  const rowEmpty = computeRowEmpty(data, width, height)
  const bands = findBands(rowEmpty)
  if (bands.length === 0) {
    return null
  }
  // Why: sheets are usually grids with the largest animation as the most-
  // populated band. Pick the band yielding the most frames so the overlay
  // shows a real walk/idle cycle rather than a single pose.
  let best: DetectedFrame[] = []
  for (const band of bands) {
    const candidate = framesInBand(data, width, band)
    if (candidate.length > best.length) {
      best = candidate
    }
  }
  if (best.length === 0) {
    return null
  }
  return { frames: best }
}

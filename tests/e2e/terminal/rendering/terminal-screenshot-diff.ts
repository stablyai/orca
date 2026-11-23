import { PNG } from 'pngjs'

export type ScreenshotDiffSummary = {
  matches: boolean
  diffPixels: number
  diffRatio: number
  width: number
  height: number
}

export function compareTerminalScreenshots(
  baselineBuffer: Buffer,
  candidateBuffer: Buffer
): ScreenshotDiffSummary {
  const baseline = PNG.sync.read(baselineBuffer)
  const candidate = PNG.sync.read(candidateBuffer)
  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    return {
      matches: false,
      diffPixels: Number.POSITIVE_INFINITY,
      diffRatio: Number.POSITIVE_INFINITY,
      width: candidate.width,
      height: candidate.height
    }
  }

  let diffPixels = 0
  for (let offset = 0; offset < baseline.data.length; offset += 4) {
    const redDiff = Math.abs((baseline.data[offset] ?? 0) - (candidate.data[offset] ?? 0))
    const greenDiff = Math.abs((baseline.data[offset + 1] ?? 0) - (candidate.data[offset + 1] ?? 0))
    const blueDiff = Math.abs((baseline.data[offset + 2] ?? 0) - (candidate.data[offset + 2] ?? 0))
    const alphaDiff = Math.abs((baseline.data[offset + 3] ?? 0) - (candidate.data[offset + 3] ?? 0))
    if (redDiff + greenDiff + blueDiff + alphaDiff > 48) {
      diffPixels += 1
    }
  }

  const pixelCount = baseline.width * baseline.height
  const diffRatio = pixelCount > 0 ? diffPixels / pixelCount : Number.POSITIVE_INFINITY
  return {
    matches: diffRatio <= 0.015,
    diffPixels,
    diffRatio,
    width: baseline.width,
    height: baseline.height
  }
}

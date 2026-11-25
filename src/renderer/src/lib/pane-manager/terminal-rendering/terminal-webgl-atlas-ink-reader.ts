import {
  MAX_RECT_SIZE,
  type AtlasCanvas,
  type GlyphInkReader,
  type GlyphRect,
  type InkRead
} from './terminal-webgl-atlas-sampling'

const SCRATCH_WIDTH = MAX_RECT_SIZE + 2
const DESTINATION_CONTROL_X = MAX_RECT_SIZE
const SOURCE_CONTROL_X = MAX_RECT_SIZE + 1

type ReadKit = { ctx: CanvasRenderingContext2D; control: HTMLCanvasElement }

function createKit(): ReadKit | null {
  if (typeof document === 'undefined') {
    return null
  }
  const element = document.createElement('canvas')
  element.width = SCRATCH_WIDTH
  element.height = MAX_RECT_SIZE
  const ctx = element.getContext('2d', { alpha: true, willReadFrequently: true })
  const control = document.createElement('canvas')
  control.width = 1
  control.height = 1
  const controlContext = control.getContext('2d')
  if (!ctx || !controlContext) {
    return null
  }
  controlContext.fillStyle = '#000'
  controlContext.fillRect(0, 0, 1, 1)
  return { ctx, control }
}

function isUsable(ctx: CanvasRenderingContext2D): boolean {
  return ctx.getContextAttributes?.().alpha !== false && ctx.isContextLost?.() !== true
}

function readOnce(
  current: ReadKit,
  canvas: AtlasCanvas,
  rect: GlyphRect,
  onReadIssued: () => void
): Exclude<InkRead, 'unavailable'> {
  const { ctx, control } = current
  if (!isUsable(ctx)) {
    return 'unreadable'
  }
  const height = Math.max(1, rect.height)
  ctx.clearRect(0, 0, SCRATCH_WIDTH, height)
  // Source-over onto transparent pixels reproduces the source's alpha.
  ctx.drawImage(
    canvas as unknown as CanvasImageSource,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height
  )
  ctx.fillStyle = '#000'
  ctx.fillRect(DESTINATION_CONTROL_X, 0, 1, 1)
  ctx.drawImage(control, SOURCE_CONTROL_X, 0)
  onReadIssued()
  const pixels = ctx.getImageData(0, 0, SCRATCH_WIDTH, height).data
  // An invalid read proves nothing, not even ink.
  const controlsPassed =
    pixels[DESTINATION_CONTROL_X * 4 + 3] === 255 && pixels[SOURCE_CONTROL_X * 4 + 3] === 255
  if (!controlsPassed || !isUsable(ctx)) {
    return 'unreadable'
  }
  const rowStride = SCRATCH_WIDTH * 4
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      if (pixels[y * rowStride + x * 4 + 3] > 0) {
        return 'ink'
      }
    }
  }
  return 'blank'
}

/** The live context and fresh controls validate the scratch copy path, with no guarantee for a specific source page. */
export function createGlyphInkReader(makeKit: () => ReadKit | null = createKit): GlyphInkReader {
  let kit: ReadKit | null = null
  return (canvas, rect, onReadIssued) => {
    try {
      kit ??= makeKit()
    } catch {
      return 'unavailable'
    }
    if (!kit) {
      return 'unavailable'
    }
    try {
      const result = readOnce(kit, canvas, rect, onReadIssued)
      if (result !== 'unreadable') {
        return result
      }
    } catch {
      // A throwing read invalidates the scratch just like a failed control.
    }
    kit = null
    return 'unreadable'
  }
}

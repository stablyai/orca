export type SentinelDivergence = {
  textCells: number
  missing: number
  missPct: number
  missingCells: Set<number>
}

export type SentinelRendererState = {
  atlasPages: number
  atlasClearModelGeneration: number | null
  atlasPageVersions: number[]
  glyphLastSeenClearModelGeneration: number | null
  glyphTextureVersions: number[]
  modelLineLengths: number[]
  vertexCount: number | null
  activeVertexBuffer: number | null
}

export type SentinelRenderInternals = {
  rows: number
  cols: number
  isPaused: boolean
  canvas: HTMLCanvasElement
  cellWidth: number
  cellHeight: number
  backgroundRgb: readonly [red: number, green: number, blue: number]
  rendererState: SentinelRendererState
}

type BufferLineLike = {
  getCell: (x: number) => { getChars: () => string; getWidth: () => number } | undefined
  translateToString: (trim: boolean) => string
}

export type BufferLike = {
  cursorY: number
  viewportY: number
  getLine: (y: number) => BufferLineLike | undefined
}

const INK_BACKGROUND_DISTANCE = 36
const MISSING_SET_MIN_OVERLAP = 0.5
let readbackCanvas: HTMLCanvasElement | null = null
let readbackContext: CanvasRenderingContext2D | null = null

export function reachRenderInternals(terminal: unknown): SentinelRenderInternals | null {
  try {
    const term = terminal as {
      rows?: number
      cols?: number
      buffer?: unknown
      _core?: {
        _renderService?: {
          _isPaused?: boolean
          _renderer?: {
            value?: {
              _canvas?: HTMLCanvasElement
              _charAtlas?: {
                clearModelGeneration?: number
                pages?: { version?: number }[]
              }
              _model?: { lineLengths?: number[] | Uint32Array }
              _glyphRenderer?: {
                value?: {
                  _activeBuffer?: number
                  _lastSeenClearModelGeneration?: number
                  _atlasTextures?: { version?: number }[]
                  _vertices?: { count?: number }
                }
              }
              _themeService?: { colors?: { background?: { rgba?: number } } }
              dimensions?: { device?: { cell?: { width?: number; height?: number } } }
            }
          }
        }
      }
    }
    const service = term._core?._renderService
    const renderer = service?._renderer?.value
    const cell = renderer?.dimensions?.device?.cell
    const backgroundRgba = renderer?._themeService?.colors?.background?.rgba
    if (
      typeof term.rows !== 'number' ||
      typeof term.cols !== 'number' ||
      !renderer?._canvas ||
      !renderer._charAtlas ||
      typeof backgroundRgba !== 'number' ||
      typeof cell?.width !== 'number' ||
      typeof cell?.height !== 'number'
    ) {
      return null
    }
    const glyphRenderer = renderer._glyphRenderer?.value
    return {
      rows: term.rows,
      cols: term.cols,
      isPaused: service?._isPaused === true,
      canvas: renderer._canvas,
      cellWidth: cell.width,
      cellHeight: cell.height,
      // xterm packs colors as RRGGBBAA; compare against the active theme so
      // light terminals do not make every background pixel look like glyph ink.
      backgroundRgb: [
        backgroundRgba >>> 24,
        (backgroundRgba >>> 16) & 255,
        (backgroundRgba >>> 8) & 255
      ],
      rendererState: {
        atlasPages: renderer._charAtlas.pages?.length ?? -1,
        atlasClearModelGeneration: renderer._charAtlas.clearModelGeneration ?? null,
        atlasPageVersions: renderer._charAtlas.pages?.map((page) => page.version ?? -1) ?? [],
        glyphLastSeenClearModelGeneration: glyphRenderer?._lastSeenClearModelGeneration ?? null,
        glyphTextureVersions:
          glyphRenderer?._atlasTextures?.map((texture) => texture.version ?? -1) ?? [],
        modelLineLengths: Array.from(renderer._model?.lineLengths ?? []),
        vertexCount: glyphRenderer?._vertices?.count ?? null,
        activeVertexBuffer: glyphRenderer?._activeBuffer ?? null
      }
    }
  } catch {
    return null
  }
}

export function activeBuffer(terminal: unknown): BufferLike | null {
  const buffer = (terminal as { buffer?: { active?: BufferLike } }).buffer?.active
  return buffer && typeof buffer.getLine === 'function' ? buffer : null
}

export function measureDivergence(
  internals: SentinelRenderInternals,
  buffer: BufferLike
): SentinelDivergence | null {
  const { canvas, cellWidth, cellHeight, rows, cols, backgroundRgb } = internals
  if (!canvas.width || !canvas.height) {
    return null
  }
  const ctx = getReadbackContext(canvas.width, canvas.height)
  if (!ctx) {
    return null
  }
  ctx.drawImage(canvas, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data

  const missingCells = new Set<number>()
  let textCells = 0
  let missing = 0
  for (let row = 0; row < rows; row++) {
    if (row === buffer.cursorY) {
      continue
    }
    const line = buffer.getLine(buffer.viewportY + row)
    if (!line) {
      continue
    }
    for (let column = 0; column < cols; column++) {
      const cell = line.getCell(column)
      if (!cell) {
        continue
      }
      const chars = cell.getChars()
      if (chars === '' || chars === ' ' || cell.getWidth() === 0) {
        continue
      }
      let ink = 0
      let sampled = 0
      const x0 = Math.round(column * cellWidth + cellWidth * 0.25)
      const x1 = Math.round(column * cellWidth + cellWidth * 0.75)
      const y0 = Math.round(row * cellHeight + cellHeight * 0.25)
      const y1 = Math.round(row * cellHeight + cellHeight * 0.75)
      for (let py = y0; py < y1; py += 2) {
        for (let px = x0; px < x1; px += 2) {
          if (px >= canvas.width || py >= canvas.height) {
            continue
          }
          const index = (py * canvas.width + px) * 4
          const distance =
            Math.abs(image[index] - backgroundRgb[0]) +
            Math.abs(image[index + 1] - backgroundRgb[1]) +
            Math.abs(image[index + 2] - backgroundRgb[2])
          if (distance > INK_BACKGROUND_DISTANCE) {
            ink++
          }
          sampled++
        }
      }
      if (!sampled) {
        continue
      }
      textCells++
      if (ink === 0) {
        missing++
        missingCells.add(row * cols + column)
      }
    }
  }
  return {
    textCells,
    missing,
    missingCells,
    missPct: textCells ? (100 * missing) / textCells : 0
  }
}

function getReadbackContext(width: number, height: number): CanvasRenderingContext2D | null {
  if (!readbackCanvas) {
    readbackCanvas = document.createElement('canvas')
    readbackContext = readbackCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (!readbackContext) {
    return null
  }
  if (readbackCanvas.width !== width) {
    readbackCanvas.width = width
  }
  if (readbackCanvas.height !== height) {
    readbackCanvas.height = height
  }
  return readbackContext
}

export function releaseRenderDesyncReadback(): void {
  // Why: the diagnostic reuses one backing store during its burst, then drops
  // the potentially multi-megabyte canvas instead of retaining it for the app lifetime.
  if (readbackCanvas) {
    readbackCanvas.width = 0
    readbackCanvas.height = 0
  }
  readbackCanvas = null
  readbackContext = null
}

export function missingSetsOverlap(a: Set<number>, b: Set<number>): boolean {
  let intersection = 0
  for (const cell of b) {
    if (a.has(cell)) {
      intersection++
    }
  }
  const union = a.size + b.size - intersection
  return union > 0 && intersection / union >= MISSING_SET_MIN_OVERLAP
}

export function bufferSnapshot(buffer: BufferLike, rows: number): string {
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
}

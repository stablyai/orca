import { PNG } from 'pngjs'

export type TerminalRasterProbeTarget = {
  clip: { x: number; y: number; width: number; height: number }
  cellWidth: number
  cellHeight: number
  rows: number
  cols: number
}

export type RasterCursorCell = {
  cellX: number
  cellY: number
  pixelCount: number
  maxColumnRun: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type ViewportSize = {
  width: number
  height: number
}

function isCursorProbePixel(red: number, green: number, blue: number, alpha: number): boolean {
  return alpha > 240 && Math.abs(red - 35) <= 2 && green >= 253 && Math.abs(blue - 69) <= 2
}

export function analyzeRasterCursorCells(
  buffer: Buffer,
  target: TerminalRasterProbeTarget,
  viewport?: ViewportSize
): RasterCursorCell[] {
  const image = PNG.sync.read(buffer)
  const scaleX = viewport ? image.width / viewport.width : image.width / target.clip.width
  const scaleY = viewport ? image.height / viewport.height : image.height / target.clip.height
  const originX = viewport ? Math.round(target.clip.x * scaleX) : 0
  const originY = viewport ? Math.round(target.clip.y * scaleY) : 0
  const maxX = viewport
    ? Math.min(image.width, originX + Math.round(target.clip.width * scaleX))
    : image.width
  const maxY = viewport
    ? Math.min(image.height, originY + Math.round(target.clip.height * scaleY))
    : image.height
  const cellWidth = Math.max(1, target.cellWidth * scaleX)
  const cellHeight = Math.max(1, target.cellHeight * scaleY)
  const cells = new Map<
    string,
    RasterCursorCell & { columnRuns: Map<number, number>; activeRunByColumn: Map<number, number> }
  >()

  for (let y = originY; y < maxY; y += 1) {
    for (let x = originX; x < maxX; x += 1) {
      const offset = (y * image.width + x) * 4
      const red = image.data[offset] ?? 0
      const green = image.data[offset + 1] ?? 0
      const blue = image.data[offset + 2] ?? 0
      const alpha = image.data[offset + 3] ?? 0
      if (!isCursorProbePixel(red, green, blue, alpha)) {
        continue
      }
      const cellX = Math.max(0, Math.min(target.cols - 1, Math.floor((x - originX) / cellWidth)))
      const cellY = Math.max(0, Math.min(target.rows - 1, Math.floor((y - originY) / cellHeight)))
      const key = `${cellX},${cellY}`
      let cell = cells.get(key)
      if (!cell) {
        cell = {
          cellX,
          cellY,
          pixelCount: 0,
          maxColumnRun: 0,
          minX: x,
          minY: y,
          maxX: x,
          maxY: y,
          columnRuns: new Map(),
          activeRunByColumn: new Map()
        }
        cells.set(key, cell)
      }
      cell.pixelCount += 1
      cell.minX = Math.min(cell.minX, x)
      cell.minY = Math.min(cell.minY, y)
      cell.maxX = Math.max(cell.maxX, x)
      cell.maxY = Math.max(cell.maxY, y)

      const previousY = cell.columnRuns.get(x)
      const nextRun = previousY === y - 1 ? (cell.activeRunByColumn.get(x) ?? 0) + 1 : 1
      cell.columnRuns.set(x, y)
      cell.activeRunByColumn.set(x, nextRun)
      cell.maxColumnRun = Math.max(cell.maxColumnRun, nextRun)
    }
  }

  return [...cells.values()]
    .filter((cell) => cell.pixelCount >= 6 && cell.maxColumnRun >= 4)
    .map(({ columnRuns: _columnRuns, activeRunByColumn: _activeRunByColumn, ...cell }) => cell)
}

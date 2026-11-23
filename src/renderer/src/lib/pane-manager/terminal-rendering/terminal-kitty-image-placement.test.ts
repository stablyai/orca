// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal, type IRenderDimensions } from '@xterm/xterm'
import { ImageAddon } from '@xterm/addon-image'
import { buildInlineImageAddonOptions } from './terminal-inline-image-options'

type ResizeOptions = {
  resizeWidth?: number
  resizeHeight?: number
}

type DrawImageRecord = {
  canvas: HTMLCanvasElement
  source: unknown
  sx?: number
  sy?: number
  sw?: number
  sh?: number
  dx: number
  dy: number
  dw: number | undefined
  dh: number | undefined
}

class FakeImageBitmap {
  public closed = false

  constructor(
    public readonly width: number,
    public readonly height: number,
    public readonly cropX: number,
    public readonly cropY: number,
    public readonly cropW: number,
    public readonly cropH: number
  ) {}

  public close(): void {
    this.closed = true
  }
}

function createPngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64)
  // PNG signature
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR chunk length (13) and tag
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  // Bit depth 8, color type 6 (RGBA)
  bytes.set([8, 6, 0, 0, 0], 24)
  // Minimal IDAT + IEND chunks so the payload exceeds the 32-byte header slice
  bytes.set([0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0], 33)
  bytes.set([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 45)
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function readSourceSize(source: unknown): Promise<{ width: number; height: number }> {
  if (source instanceof Blob) {
    return source
      .slice(0, 32)
      .arrayBuffer()
      .then((buffer) => {
        const view = new DataView(buffer)
        return {
          width: view.getUint32(16, false),
          height: view.getUint32(20, false)
        }
      })
  }
  if (source instanceof FakeImageBitmap) {
    return Promise.resolve({ width: source.width, height: source.height })
  }
  if (source instanceof HTMLCanvasElement) {
    return Promise.resolve({ width: source.width, height: source.height })
  }
  if (typeof source === 'object' && source !== null && 'width' in source && 'height' in source) {
    const sized = source
    const width = typeof sized.width === 'number' ? sized.width : 1
    const height = typeof sized.height === 'number' ? sized.height : 1
    return Promise.resolve({ width, height })
  }
  return Promise.resolve({ width: 1, height: 1 })
}

function writeTerminalParseOnly(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

async function settleImageDecodes(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

async function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  await writeTerminalParseOnly(terminal, data)
  await settleImageDecodes()
}

function kittyTransmitDisplay(id: number, params: string, pngBase64: string): string {
  return `\x1b_Ga=T,f=100,i=${id},${params};${pngBase64}\x1b\\`
}

function kittyPlace(id: number, params: string): string {
  return `\x1b_Ga=p,i=${id},${params}\x1b\\`
}

function kittyDelete(selector: string, id: number): string {
  return `\x1b_Ga=d,d=${selector},i=${id}\x1b\\`
}

type TestHarness = {
  terminal: Terminal
  addon: ImageAddon
  container: HTMLDivElement
  responses: string[]
  createdBitmaps: FakeImageBitmap[]
  drawRecords: DrawImageRecord[]
  flushAnimationFrames: () => void
  dispose: () => void
}

const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function createTerminalHarness(cellWidth = 8, cellHeight = 16, cols = 80, rows = 24): TestHarness {
  const originalGetContextDescriptor = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext'
  )
  const originalImageData = globalThis.ImageData
  const createdBitmaps: FakeImageBitmap[] = []
  const drawRecords: DrawImageRecord[] = []
  const contexts = new WeakMap<HTMLCanvasElement, Record<string, unknown>>()
  const rafQueue: { id: number; callback: FrameRequestCallback; cancelled: boolean }[] = []
  let nextRafId = 1

  class FakeImageData {
    public readonly data: Uint8ClampedArray
    public readonly width: number
    public readonly height: number

    constructor(
      dataOrWidth: Uint8ClampedArray | number,
      widthOrHeight: number,
      maybeHeight?: number
    ) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth
        this.height = widthOrHeight
        this.data = new Uint8ClampedArray(this.width * this.height * 4)
      } else {
        this.data = dataOrWidth
        this.width = widthOrHeight
        this.height = maybeHeight ?? Math.floor(dataOrWidth.length / (4 * widthOrHeight))
      }
    }
  }

  vi.stubGlobal('ImageBitmap', FakeImageBitmap)
  if (originalImageData === undefined) {
    vi.stubGlobal('ImageData', FakeImageData)
  }
  vi.stubGlobal(
    'createImageBitmap',
    async (
      source: unknown,
      sxOrOptions?: number | ResizeOptions,
      sy?: number,
      sw?: number,
      sh?: number,
      cropOptions?: ResizeOptions
    ): Promise<FakeImageBitmap> => {
      const size = await readSourceSize(source)
      const isCroppedArgs = typeof sxOrOptions === 'number'
      const cropX = isCroppedArgs ? sxOrOptions : 0
      const cropY = isCroppedArgs ? (sy ?? 0) : 0
      const cropW = isCroppedArgs ? (sw ?? size.width) : size.width
      const cropH = isCroppedArgs ? (sh ?? size.height) : size.height
      const options = isCroppedArgs
        ? cropOptions
        : typeof sxOrOptions === 'object'
          ? sxOrOptions
          : undefined
      const width = options?.resizeWidth ?? cropW
      const height = options?.resizeHeight ?? cropH
      const bitmap = new FakeImageBitmap(width, height, cropX, cropY, cropW, cropH)
      createdBitmaps.push(bitmap)
      return bitmap
    }
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = nextRafId++
    rafQueue.push({ id, callback, cancelled: false })
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    const entry = rafQueue.find((item) => item.id === id)
    if (entry) {
      entry.cancelled = true
    }
  })

  const createFakeContext = (canvas: HTMLCanvasElement): Record<string, unknown> => {
    const ctx: Record<string, unknown> = {
      canvas,
      fillStyle: '',
      font: '',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {},
      fillText: () => {},
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4)
      }),
      putImageData: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4)
      }),
      measureText: (text: string) => ({
        width: text.length * cellWidth,
        actualBoundingBoxAscent: cellHeight * 0.8,
        actualBoundingBoxDescent: cellHeight * 0.2,
        fontBoundingBoxAscent: cellHeight * 0.8,
        fontBoundingBoxDescent: cellHeight * 0.2
      }),
      drawImage: (...args: readonly unknown[]) => {
        const source = args[0]
        if (args.length >= 9) {
          drawRecords.push({
            canvas,
            source,
            sx: typeof args[1] === 'number' ? args[1] : undefined,
            sy: typeof args[2] === 'number' ? args[2] : undefined,
            sw: typeof args[3] === 'number' ? args[3] : undefined,
            sh: typeof args[4] === 'number' ? args[4] : undefined,
            dx: typeof args[5] === 'number' ? args[5] : 0,
            dy: typeof args[6] === 'number' ? args[6] : 0,
            dw: typeof args[7] === 'number' ? args[7] : undefined,
            dh: typeof args[8] === 'number' ? args[8] : undefined
          })
        } else {
          drawRecords.push({
            canvas,
            source,
            dx: typeof args[1] === 'number' ? args[1] : 0,
            dy: typeof args[2] === 'number' ? args[2] : 0,
            dw: typeof args[3] === 'number' ? args[3] : undefined,
            dh: typeof args[4] === 'number' ? args[4] : undefined
          })
        }
      }
    }
    return ctx
  }

  let container: HTMLDivElement | undefined
  let terminal: Terminal | undefined
  let addon: ImageAddon | undefined
  let disposed = false

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    try {
      addon?.dispose()
      terminal?.dispose()
      container?.remove()
    } finally {
      if (originalGetContextDescriptor) {
        Object.defineProperty(
          HTMLCanvasElement.prototype,
          'getContext',
          originalGetContextDescriptor
        )
      }
      vi.unstubAllGlobals()
    }
  }
  cleanups.push(dispose)

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement, contextType: string): unknown {
      if (contextType !== '2d') {
        return null
      }
      const ctx = contexts.get(this) ?? createFakeContext(this)
      contexts.set(this, ctx)
      return ctx
    }
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  terminal = new Terminal({ cols, rows, allowProposedApi: true })
  terminal.open(container)

  const canvasWidth = cols * cellWidth
  const canvasHeight = rows * cellHeight
  const dimensions: IRenderDimensions = {
    css: {
      canvas: { width: canvasWidth, height: canvasHeight },
      cell: { width: cellWidth, height: cellHeight }
    },
    device: {
      canvas: { width: canvasWidth, height: canvasHeight },
      cell: { width: cellWidth, height: cellHeight },
      char: { width: cellWidth, height: cellHeight, top: 0, left: 0 }
    }
  }
  Object.defineProperty(terminal, 'dimensions', {
    configurable: true,
    get: () => dimensions
  })

  addon = new ImageAddon(buildInlineImageAddonOptions())
  terminal.loadAddon(addon)

  const responses: string[] = []
  terminal.onData((data) => responses.push(data))

  const flushAnimationFrames = (): void => {
    let safety = 0
    while (rafQueue.length > 0 && safety < 20) {
      safety += 1
      const pending = rafQueue.splice(0)
      for (const item of pending) {
        if (!item.cancelled) {
          item.callback(performance.now())
        }
      }
    }
  }

  return {
    terminal,
    addon,
    container,
    responses,
    createdBitmaps,
    drawRecords,
    flushAnimationFrames,
    dispose
  }
}

describe('kitty image placement and cleanup', () => {
  it('reuses cached ImageBitmaps across a=d,d=i and variable a=p crops without re-decoding, and closes bitmaps cleanly', async () => {
    const harness = createTerminalHarness(8, 16, 80, 24)
    const pngBase64 = toBase64(createPngBytes(4, 4))

    await writeTerminal(harness.terminal, kittyTransmitDisplay(1, 'c=4,r=2,C=1', pngBase64))
    expect(harness.responses).toContain('\x1b_Gi=1;OK\x1b\\')
    expect(harness.createdBitmaps).toHaveLength(1)
    const firstBitmap = harness.createdBitmaps[0]
    expect(firstBitmap.closed).toBe(false)
    expect(firstBitmap.width).toBe(4)
    expect(firstBitmap.height).toBe(4)
    expect(harness.addon.extractTileAtBufferCell(0, 0)).toBeDefined()

    // Render initial frame so the top layer canvas mounts into the DOM before scroll deletion.
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()
    const topLayer = harness.container.querySelector('.xterm-image-layer-top')
    expect(topLayer).not.toBeNull()

    // Delete active placement only (d=i): retain decoded bitmap and keep canvas layer mounted.
    await writeTerminal(harness.terminal, kittyDelete('i', 1))
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()

    expect(firstBitmap.closed).toBe(false)
    expect(harness.addon.extractTileAtBufferCell(0, 0)).toBeUndefined()
    expect(harness.container.querySelector('.xterm-image-layer-top')).toBe(topLayer)

    // Re-place at (col=2, row=3) with matching crop and dimensions: reuses cached bitmap synchronously.
    harness.responses.length = 0
    await writeTerminal(harness.terminal, `\x1b[4;3H${kittyPlace(1, 'c=4,r=2,C=1')}`)
    expect(harness.responses).toContain('\x1b_Gi=1;OK\x1b\\')
    expect(harness.createdBitmaps).toHaveLength(1)
    expect(firstBitmap.closed).toBe(false)
    expect(harness.addon.extractTileAtBufferCell(2, 3)).toBeDefined()
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()
    expect(harness.container.querySelector('.xterm-image-layer-top')).toBe(topLayer)

    // Delete placement then place with changed crop/size: reuses native decoded bitmap via GPU crop with zero re-decode.
    await writeTerminal(
      harness.terminal,
      `${kittyDelete('i', 1)}${kittyPlace(1, 'y=1,h=2,c=4,r=1,C=1')}`
    )
    expect(firstBitmap.closed).toBe(false)
    expect(harness.createdBitmaps).toHaveLength(1)
    expect(harness.addon.extractTileAtBufferCell(2, 3)).toBeDefined()
    expect(harness.addon.extractTileAtBufferCell(2, 4)).toBeUndefined()

    // Deleting image data (d=I) detaches the empty layer canvas, and d=A clears content cache and closes bitmaps.
    await writeTerminal(harness.terminal, kittyDelete('i', 1))
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()
    expect(firstBitmap.closed).toBe(false)
    expect(harness.container.querySelector('.xterm-image-layer-top')).toBe(topLayer)

    await writeTerminal(harness.terminal, kittyDelete('I', 1))
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()
    expect(harness.container.querySelector('.xterm-image-layer-top')).toBeNull()

    await writeTerminal(harness.terminal, kittyDelete('A', 0))
    expect(firstBitmap.closed).toBe(true)
  })

  it('closes alternate-screen cached bitmaps and detaches layer canvas when leaving alternate screen', async () => {
    const harness = createTerminalHarness(8, 16, 80, 24)
    const pngBase64 = toBase64(createPngBytes(4, 4))

    await writeTerminal(
      harness.terminal,
      `\x1b[?1049h${kittyTransmitDisplay(1, 'c=4,r=2,C=1', pngBase64)}`
    )
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()
    const topLayer = harness.container.querySelector('.xterm-image-layer-top')
    expect(topLayer).not.toBeNull()

    await writeTerminal(harness.terminal, kittyDelete('i', 1))
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()

    expect(harness.createdBitmaps).toHaveLength(1)
    expect(harness.createdBitmaps[0].closed).toBe(false)
    expect(harness.container.querySelector('.xterm-image-layer-top')).toBe(topLayer)

    await writeTerminal(harness.terminal, '\x1b[?1049l')
    harness.flushAnimationFrames()

    expect(harness.createdBitmaps[0].closed).toBe(true)
    expect(harness.container.querySelector('.xterm-image-layer-top')).toBeNull()
  })

  it('keeps explicit cell grid tight on fractional cell metrics and avoids scrolling when C=1', async () => {
    const harness = createTerminalHarness(7.77, 16.33, 80, 24)
    const pngBase64 = toBase64(createPngBytes(808, 620))

    // Place 52x19 image at cursor (col=2, row=5) -> occupies cols [2..53], rows [5..23]
    await writeTerminal(
      harness.terminal,
      `\x1b[6;3H${kittyTransmitDisplay(1, 'c=52,r=19,C=1', pngBase64)}`
    )
    expect(harness.terminal.buffer.active.baseY).toBe(0)
    expect(harness.terminal.buffer.active.cursorX).toBe(2)
    expect(harness.terminal.buffer.active.cursorY).toBe(5)
    expect(harness.createdBitmaps[0].width).toBe(808)
    expect(harness.createdBitmaps[0].height).toBe(620)
    expect(harness.addon.extractTileAtBufferCell(2, 5)).toBeDefined()
    expect(harness.addon.extractTileAtBufferCell(53, 23)).toBeDefined()
    expect(harness.addon.extractTileAtBufferCell(54, 5)).toBeUndefined()
    expect(harness.addon.extractTileAtBufferCell(2, 24)).toBeUndefined()

    // Place near the bottom edge with C=1: must clip to 4 visible rows (sampling 4/19 of source height) instead of scrolling
    await writeTerminal(
      harness.terminal,
      `${kittyDelete('i', 1)}\x1b[21;3H${kittyPlace(1, 'c=52,r=19,C=1')}`
    )
    expect(harness.terminal.buffer.active.baseY).toBe(0)
    expect(harness.terminal.buffer.active.cursorX).toBe(2)
    expect(harness.terminal.buffer.active.cursorY).toBe(20)
    expect(harness.addon.extractTileAtBufferCell(2, 20)).toBeDefined()
    expect(harness.addon.extractTileAtBufferCell(53, 23)).toBeDefined()

    harness.drawRecords.length = 0
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()
    const topLayer = harness.container.querySelector('.xterm-image-layer-top')
    const clippedDraws = harness.drawRecords.filter((record) => record.canvas === topLayer)
    expect(clippedDraws).toHaveLength(1)
    expect(clippedDraws[0]?.sx).toBe(0)
    expect(clippedDraws[0]?.sy).toBe(0)
    expect(clippedDraws[0]?.sw).toBe(808)
    expect(clippedDraws[0]?.sh).toBeCloseTo((4 / 19) * 620, 3)
  })

  it('never draws checkerboard placeholders on untouched cells after a=d,d=i under Orca defaults', async () => {
    const cellWidth = 8
    const harness = createTerminalHarness(cellWidth, 16, 80, 24)
    const pngBase64 = toBase64(createPngBytes(4, 4))
    const pngBase64B = toBase64(createPngBytes(6, 6))

    await writeTerminal(harness.terminal, kittyTransmitDisplay(1, 'c=4,r=2,C=1', pngBase64))
    await writeTerminal(harness.terminal, kittyDelete('i', 1))
    await writeTerminal(
      harness.terminal,
      `\x1b[1;11H${kittyTransmitDisplay(2, 'c=4,r=2,C=1', pngBase64B)}`
    )

    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()

    const topLayer = harness.container.querySelector('.xterm-image-layer-top')
    expect(topLayer).not.toBeNull()

    harness.drawRecords.length = 0
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()

    const topDraws = harness.drawRecords.filter((record) => record.canvas === topLayer)
    expect(topDraws.length).toBeGreaterThan(0)
    expect(
      topDraws.every(
        (record) => record.source === harness.createdBitmaps[1] && record.dx >= 10 * cellWidth
      )
    ).toBe(true)
  })

  it('places SIXEL at origin without moving cursor when DECSET ?80h is active', async () => {
    const harness = createTerminalHarness(8, 16, 80, 24)

    await writeTerminal(harness.terminal, '\x1b[6;6H\x1b[?80h\x1bPq#0;2;100;0;0#0~~~-\x1b\\')
    expect(harness.addon.extractTileAtBufferCell(0, 0)).toBeDefined()
    expect(harness.terminal.buffer.active.cursorX).toBe(5)
    expect(harness.terminal.buffer.active.cursorY).toBe(5)
  })

  it('coalesces contiguous image rows into a single drawImage call and splits around overwritten cells', async () => {
    const cellWidth = 8
    const cellHeight = 16
    const harness = createTerminalHarness(cellWidth, cellHeight, 80, 24)
    const pngBase64 = toBase64(createPngBytes(4 * cellWidth, 4 * cellHeight))

    await writeTerminal(harness.terminal, kittyTransmitDisplay(10, 'c=4,r=4,C=1,q=2', pngBase64))
    harness.drawRecords.length = 0
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()

    const topLayer = harness.container.querySelector('.xterm-image-layer-top')
    expect(topLayer).not.toBeNull()

    const fullDraws = harness.drawRecords.filter((record) => record.canvas === topLayer)
    expect(fullDraws).toHaveLength(1)
    expect(fullDraws[0]).toMatchObject({
      source: harness.createdBitmaps[0],
      dx: 0,
      dy: 0,
      dw: 4 * cellWidth,
      dh: 4 * cellHeight
    })

    // Overwrite cell (col=1, row=1): the rect splits cleanly around (1, 1) without drawing over it.
    await writeTerminal(harness.terminal, '\x1b[2;2HX')
    harness.drawRecords.length = 0
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()

    const splitDraws = harness.drawRecords.filter((record) => record.canvas === topLayer)
    expect(splitDraws.length).toBeGreaterThan(1)
    const coveredCells = new Set<string>()
    for (const record of splitDraws) {
      const startCol = Math.round(record.dx / cellWidth)
      const endCol = Math.round((record.dx + (record.dw ?? 0)) / cellWidth)
      const startRow = Math.round(record.dy / cellHeight)
      const endRow = Math.round((record.dy + (record.dh ?? 0)) / cellHeight)
      for (let r = startRow; r < endRow; r += 1) {
        for (let c = startCol; c < endCol; c += 1) {
          coveredCells.add(`${c},${r}`)
        }
      }
    }
    expect(coveredCells.has('1,1')).toBe(false)
    expect(coveredCells.size).toBe(15)
  })

  it('presents completed DEC 2026 frames when an rAF is skipped before back-to-back reopen', async () => {
    const harness = createTerminalHarness(8, 16, 80, 24)
    // Perform initial render so _hasRenderedOnce is true.
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    harness.flushAnimationFrames()

    let renderCount = 0
    const sub = harness.terminal.onRender(() => {
      renderCount += 1
    })

    // Queue a debounced refresh before DEC 2026 opens, then fire rAF while synchronizedOutput is held (simulating skipped vsync).
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    await writeTerminalParseOnly(harness.terminal, '\x1b[?2026hFrame 1')
    harness.flushAnimationFrames()
    expect(renderCount).toBe(0)

    // Close Frame 1 and immediately reopen Frame 2 in the same write: Frame 1 must present synchronously.
    harness.terminal.refresh(0, harness.terminal.rows - 1)
    await writeTerminalParseOnly(harness.terminal, '\x1b[?2026l\x1b[?2026hFrame 2')
    expect(renderCount).toBe(1)
    expect(harness.terminal.modes.synchronizedOutputMode).toBe(true)

    // Frame 2 must not paint mid-frame on rAF, then presents once ?2026l closes.
    harness.flushAnimationFrames()
    expect(renderCount).toBe(1)

    await writeTerminalParseOnly(harness.terminal, '\x1b[?2026l')
    harness.flushAnimationFrames()
    expect(renderCount).toBe(2)

    sub.dispose()
  })

  it('schedules a=T PNG decodes without blocking parser completion and skips superseded pending frames', async () => {
    const harness = createTerminalHarness(8, 16, 80, 24)
    const pendingResolvers: (() => void)[] = []
    const origCib = globalThis.createImageBitmap
    let startedDecodes = 0
    vi.stubGlobal(
      'createImageBitmap',
      (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        startedDecodes += 1
        return new Promise<ImageBitmap>((resolve, reject) => {
          pendingResolvers.push(() => {
            void origCib(source, options).then(resolve, reject)
          })
        })
      }
    )

    const png1 = toBase64(createPngBytes(32, 32))
    const png2 = toBase64(createPngBytes(36, 32))
    const png3 = toBase64(createPngBytes(40, 32))
    const png4 = toBase64(createPngBytes(44, 32))
    let parsedResolved = false
    const parsePromise = writeTerminalParseOnly(
      harness.terminal,
      `\x1b[?1049h\x1b[1;1H${kittyTransmitDisplay(1, 'c=4,r=2', png1)}after`
    ).then(() => {
      parsedResolved = true
    })

    await parsePromise
    // Parser finished and advanced cursor past c=4 + 'after' while createImageBitmap is still pending.
    expect(parsedResolved).toBe(true)
    expect(harness.terminal.buffer.active.cursorX).toBe(9)
    expect(startedDecodes).toBe(1)

    // Supersede frames 2 and 3 synchronously with frame 4 before slot 1 finishes decoding.
    await writeTerminalParseOnly(
      harness.terminal,
      `\x1b[1;1H${kittyTransmitDisplay(2, 'c=4,r=2,C=1', png2)}` +
        `\x1b[1;1H${kittyTransmitDisplay(3, 'c=4,r=2,C=1', png3)}` +
        `\x1b[1;1H${kittyTransmitDisplay(4, 'c=4,r=2,C=1', png4)}`
    )
    expect(startedDecodes).toBe(1)

    while (pendingResolvers.length > 0) {
      pendingResolvers.shift()?.()
      await settleImageDecodes()
    }
    await settleImageDecodes()

    // Only frame 1 and the latest pending frame (4) decoded; frames 2 and 3 were skipped while busy.
    expect(startedDecodes).toBe(2)
    expect(harness.responses).toContain('\x1b_Gi=4;OK\x1b\\')
    expect(harness.createdBitmaps).toHaveLength(2)
    expect(harness.createdBitmaps[1]?.closed).toBe(false)

    await writeTerminal(harness.terminal, '\x1b[?1049l')
    expect(harness.createdBitmaps[0]?.closed).toBe(true)
    expect(harness.createdBitmaps[1]?.closed).toBe(true)
  })

  it('prunes normal-buffer placements erased by ED2 (\\x1b[2J) and keeps fallback bitmaps drawable without leaking', async () => {
    const harness = createTerminalHarness(8, 16, 80, 24)
    const pendingResolvers: (() => void)[] = []
    const origCib = globalThis.createImageBitmap
    let startedDecodes = 0
    vi.stubGlobal(
      'createImageBitmap',
      (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        startedDecodes += 1
        return new Promise<ImageBitmap>((resolve, reject) => {
          pendingResolvers.push(() => {
            void origCib(source, options).then(resolve, reject)
          })
        })
      }
    )

    const png1 = toBase64(createPngBytes(32, 32))
    const png2 = toBase64(createPngBytes(36, 32))
    const png3 = toBase64(createPngBytes(40, 32))
    const png4 = toBase64(createPngBytes(44, 32))

    // Frame 1 on the normal buffer finishes decoding cleanly.
    const frame1Promise = writeTerminalParseOnly(
      harness.terminal,
      `\x1b[H\x1b[2J${kittyTransmitDisplay(1, 'c=4,r=2', png1)}`
    )
    await frame1Promise
    expect(startedDecodes).toBe(1)
    pendingResolvers.shift()?.()
    await settleImageDecodes()
    expect(harness.createdBitmaps).toHaveLength(1)
    expect(harness.createdBitmaps[0]?.closed).toBe(false)

    // Clear the viewport with ED2 and transmit Frame 2 while its decode stays pending:
    // Frame 1's bitmap must transfer to Frame 2 as fallback and paint on rAF.
    harness.drawRecords.length = 0
    await writeTerminalParseOnly(
      harness.terminal,
      `\x1b[H\x1b[2J${kittyTransmitDisplay(2, 'c=4,r=2,C=1', png2)}`
    )
    expect(startedDecodes).toBe(2)
    expect(harness.createdBitmaps[0]?.closed).toBe(false)

    harness.flushAnimationFrames()
    expect(harness.drawRecords.some((record) => record.source === harness.createdBitmaps[0])).toBe(
      true
    )

    // Erase Frame 2 and Frame 3 via ED2 while Frame 2 is still decoding: Frame 3 must be
    // skipped without starting createImageBitmap, and Frame 1's bitmap stays alive as fallback.
    await writeTerminalParseOnly(
      harness.terminal,
      `\x1b[H\x1b[2J${kittyTransmitDisplay(3, 'c=4,r=2,C=1', png3)}` +
        `\x1b[H\x1b[2J${kittyTransmitDisplay(4, 'c=4,r=2,C=1', png4)}`
    )
    expect(startedDecodes).toBe(2)
    expect(harness.createdBitmaps[0]?.closed).toBe(false)

    while (pendingResolvers.length > 0) {
      pendingResolvers.shift()?.()
      await settleImageDecodes()
    }
    await settleImageDecodes()

    expect(startedDecodes).toBe(3)
    expect(harness.responses).toContain('\x1b_Gi=4;OK\x1b\\')
    expect(harness.createdBitmaps).toHaveLength(3)
    expect(harness.createdBitmaps[2]?.closed).toBe(false)

    await writeTerminal(harness.terminal, kittyDelete('A', 0))
    expect(harness.createdBitmaps[0]?.closed).toBe(true)
    expect(harness.createdBitmaps[1]?.closed).toBe(true)
    expect(harness.createdBitmaps[2]?.closed).toBe(true)
  })

  it('deduplicates identical PNG retransmissions after a=d,d=I without re-decoding', async () => {
    const harness = createTerminalHarness(8, 16, 80, 24)
    const pngBase64 = toBase64(createPngBytes(16, 16))

    await writeTerminal(
      harness.terminal,
      `\x1b[?1049h${kittyTransmitDisplay(1, 'c=4,r=2,C=1', pngBase64)}`
    )
    expect(harness.createdBitmaps).toHaveLength(1)
    expect(harness.addon.extractTileAtBufferCell(0, 0)).toBeDefined()

    await writeTerminal(
      harness.terminal,
      `${kittyDelete('I', 1)}\x1b[1;1H${kittyTransmitDisplay(2, 'c=4,r=2,C=1', pngBase64)}`
    )
    expect(harness.createdBitmaps).toHaveLength(1)
    expect(harness.createdBitmaps[0]?.closed).toBe(false)
    expect(harness.addon.extractTileAtBufferCell(0, 0)).toBeDefined()

    await writeTerminal(harness.terminal, '\x1b[?1049l')
    expect(harness.createdBitmaps[0]?.closed).toBe(true)
  })
})

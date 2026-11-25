/** Alpha-only 2D context: enough of the canvas model for the reader's copy and control pixels. */
export type ScratchState = {
  dropControl?: 'source' | 'destination' | 'both'
  lost?: boolean
  beforeSourceControl?: () => void
}

export function fakeKit(options: ScratchState = {}) {
  const width = 258
  const alpha = new Uint8ClampedArray(width * 256)
  const ctx = {
    fillStyle: '',
    getContextAttributes: () => ({ alpha: true }),
    isContextLost: () => options.lost === true,
    clearRect: (x: number, y: number, w: number, h: number) => {
      for (let row = y; row < y + h; row++) {
        alpha.fill(0, row * width + x, row * width + x + w)
      }
    },
    fillRect: (x: number, y: number) => {
      if (options.dropControl !== 'destination' && options.dropControl !== 'both') {
        alpha[y * width + x] = 255
      }
    },
    drawImage: (source: { alphaAt?: (x: number, y: number) => number }, ...args: number[]) => {
      if (args.length === 2) {
        options.beforeSourceControl?.()
        if (options.dropControl !== 'source' && options.dropControl !== 'both') {
          alpha[args[1] * width + args[0]] = 255
        }
        return
      }
      const [sx, sy, sw, sh, dx, dy] = args
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          alpha[(dy + y) * width + dx + x] = source.alphaAt?.(sx + x, sy + y) ?? 0
        }
      }
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          data[(y * w + x) * 4 + 3] = alpha[y * width + x]
        }
      }
      return { data }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake supplies the reader's canvas operations and recognizes its control token in drawImage.
  return { ctx: ctx as unknown as CanvasRenderingContext2D, control: {} as HTMLCanvasElement }
}

export const pageWithInk = (inked: boolean) => ({
  width: 512,
  height: 512,
  alphaAt: (x: number, y: number) => (inked && x === 3 && y === 0 ? 255 : 0)
})

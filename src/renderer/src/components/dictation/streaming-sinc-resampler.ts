// Kernel zero crossings per side; 16 with a Blackman window keeps aliases below about -70 dB.
const ZERO_CROSSINGS = 16
const TABLE_STEPS_PER_CROSSING = 256
// Cutoff as a share of the lower Nyquist, leaving room for the filter's transition band.
const ROLLOFF = 0.9

function buildKernelTable(): Float32Array {
  const length = ZERO_CROSSINGS * TABLE_STEPS_PER_CROSSING
  // One trailing zero lets the interpolation read past the last tap.
  const table = new Float32Array(length + 2)
  table[0] = 1
  for (let index = 1; index <= length; index += 1) {
    const x = index / TABLE_STEPS_PER_CROSSING
    const r = index / length
    const window = 0.42 + 0.5 * Math.cos(Math.PI * r) + 0.08 * Math.cos(2 * Math.PI * r)
    table[index] = (Math.sin(Math.PI * x) / (Math.PI * x)) * window
  }
  return table
}

const KERNEL_TABLE = buildKernelTable()

/** Windowed-sinc resampler for a continuous stream fed in arbitrary-sized blocks. */
export class StreamingSincResampler {
  private readonly passthrough: boolean
  private readonly step: number
  private readonly scale: number
  private readonly halfWidth: number
  private history: Float32Array
  private historyLength: number
  // Input index (into history) of the next output sample.
  private position: number
  private output = new Float32Array(0)

  constructor(inputRate: number, outputRate: number) {
    this.passthrough = inputRate === outputRate
    this.step = inputRate / outputRate
    this.scale = Math.min(1, outputRate / inputRate) * ROLLOFF
    this.halfWidth = ZERO_CROSSINGS / this.scale
    // Leading zeros put the first output on the first input sample.
    this.historyLength = Math.ceil(this.halfWidth)
    this.position = this.historyLength
    this.history = new Float32Array(this.historyLength * 2 + 256)
  }

  /** Returns a view that the next call reuses: copy what you keep. */
  process(input: Float32Array): Float32Array {
    if (this.passthrough) {
      return input
    }
    this.append(input)
    const maxOutput = Math.ceil(this.historyLength / this.step) + 1
    if (this.output.length < maxOutput) {
      this.output = new Float32Array(maxOutput)
    }
    const { history, scale, halfWidth } = this
    const table = KERNEL_TABLE
    const tableScale = scale * TABLE_STEPS_PER_CROSSING
    const lastIndex = this.historyLength - 1
    let count = 0
    while (this.position + halfWidth <= lastIndex) {
      const center = this.position
      const first = Math.ceil(center - halfWidth)
      const last = Math.floor(center + halfWidth)
      let sum = 0
      for (let index = first; index <= last; index += 1) {
        const tablePosition = Math.abs(center - index) * tableScale
        const tableIndex = Math.floor(tablePosition)
        const fraction = tablePosition - tableIndex
        const tap = table[tableIndex] + fraction * (table[tableIndex + 1] - table[tableIndex])
        sum += history[index] * tap
      }
      this.output[count] = sum * scale
      count += 1
      this.position += this.step
    }
    this.discardConsumed()
    return this.output.subarray(0, count)
  }

  private append(input: Float32Array): void {
    const needed = this.historyLength + input.length
    if (needed > this.history.length) {
      const grown = new Float32Array(needed * 2)
      grown.set(this.history.subarray(0, this.historyLength))
      this.history = grown
    }
    this.history.set(input, this.historyLength)
    this.historyLength = needed
  }

  private discardConsumed(): void {
    const consumed = Math.floor(this.position - this.halfWidth)
    if (consumed <= 0) {
      return
    }
    this.history.copyWithin(0, consumed, this.historyLength)
    this.historyLength -= consumed
    this.position -= consumed
  }
}

export const PACED_TYPING_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz'

export type LatencyStats = {
  count: number
  p50: number
  p90: number
  p99: number
  max: number
}

export type KeySample = {
  seq: number
  expectedChar: string
  receivedChar: string
  plannedAt: number
  /** Actual test-driver dispatch time. Kept as sentAt for report compatibility. */
  sentAt: number
  ptyArrivedAt: number | null
  echoSeenAt: number | null
  dispatchDelayMs: number
  plannedToPtyArrivalMs: number
  plannedToBufferEchoMs: number
}

export type PacedTypingMeasurement = {
  dispatchModel: 'absolute-targets-serialized-cdp'
  echoObservation: 'xterm-buffer-poll'
  keyCount: number
  dispatchDelayMs: LatencyStats | null
  plannedToPtyArrivalMs: LatencyStats | null
  plannedToBufferEchoMs: LatencyStats | null
  /** Actual driver dispatch to polled xterm-buffer detection. */
  totalMs: LatencyStats | null
  /** Actual driver dispatch to PTY-process receipt. */
  inputHalfMs: LatencyStats | null
  /** PTY-process receipt to polled xterm-buffer detection. */
  echoHalfMs: LatencyStats | null
  maxTimerDriftMs: number
  samples: KeySample[]
}

export type KeyArrivalRecord = {
  seq: number
  atMs: number
  char: string
}

function latencyStats(samples: number[]): LatencyStats | null {
  if (samples.length === 0) {
    return null
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    count: sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0
  }
}

export function parseKeyArrivalSidecar(raw: string): Map<number, KeyArrivalRecord> {
  const arrivals = new Map<number, KeyArrivalRecord>()
  const lines = raw.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue
    }
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      if (index === lines.length - 1 && !raw.endsWith('\n')) {
        continue
      }
      throw new Error(`Invalid typing arrival sidecar line ${index + 1}`)
    }
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('seq' in entry) ||
      !('atMs' in entry) ||
      !('char' in entry) ||
      typeof entry.seq !== 'number' ||
      !Number.isInteger(entry.seq) ||
      entry.seq < 1 ||
      typeof entry.atMs !== 'number' ||
      !Number.isFinite(entry.atMs) ||
      typeof entry.char !== 'string' ||
      entry.char.length === 0
    ) {
      throw new Error(`Invalid typing arrival record on line ${index + 1}`)
    }
    if (arrivals.has(entry.seq)) {
      throw new Error(`Duplicate typing arrival sequence ${entry.seq}`)
    }
    arrivals.set(entry.seq, { seq: entry.seq, atMs: entry.atMs, char: entry.char })
  }
  return arrivals
}

function validateExpectedSeqs<T>(
  label: string,
  values: ReadonlyMap<number, T>,
  keyCount: number
): void {
  const missing: number[] = []
  const unexpected: number[] = []
  for (let seq = 1; seq <= keyCount; seq += 1) {
    if (!values.has(seq)) {
      missing.push(seq)
    }
  }
  for (const seq of values.keys()) {
    if (!Number.isInteger(seq) || seq < 1 || seq > keyCount) {
      unexpected.push(seq)
    }
  }
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} sequence mismatch: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`
    )
  }
}

export function buildPacedTypingMeasurement(args: {
  keyCount: number
  plannedAtBySeq: ReadonlyMap<number, number>
  sentAtBySeq: ReadonlyMap<number, number>
  arrivals: ReadonlyMap<number, KeyArrivalRecord>
  echoSeenAt: ReadonlyMap<number, number>
  maxTimerDriftMs: number
}): PacedTypingMeasurement {
  if (!Number.isInteger(args.keyCount) || args.keyCount < 1) {
    throw new Error(`Invalid typing key count ${args.keyCount}`)
  }
  if (!Number.isFinite(args.maxTimerDriftMs) || args.maxTimerDriftMs < 0) {
    throw new Error(`Invalid timer drift ${args.maxTimerDriftMs}`)
  }
  validateExpectedSeqs('planned dispatch', args.plannedAtBySeq, args.keyCount)
  validateExpectedSeqs('actual dispatch', args.sentAtBySeq, args.keyCount)
  validateExpectedSeqs('PTY arrival', args.arrivals, args.keyCount)
  validateExpectedSeqs('buffer echo', args.echoSeenAt, args.keyCount)

  const samples: KeySample[] = []
  const dispatchDelayMs: number[] = []
  const plannedToPtyArrivalMs: number[] = []
  const plannedToBufferEchoMs: number[] = []
  const totalMs: number[] = []
  const inputHalfMs: number[] = []
  const echoHalfMs: number[] = []
  for (let seq = 1; seq <= args.keyCount; seq += 1) {
    const plannedAt = args.plannedAtBySeq.get(seq)
    const sentAt = args.sentAtBySeq.get(seq)
    const arrival = args.arrivals.get(seq)
    const seenAt = args.echoSeenAt.get(seq)
    if (
      plannedAt === undefined ||
      sentAt === undefined ||
      arrival === undefined ||
      seenAt === undefined
    ) {
      throw new Error(`Typing sample ${seq} is incomplete`)
    }
    if (![plannedAt, sentAt, arrival.atMs, seenAt].every(Number.isFinite)) {
      throw new Error(`Typing sample ${seq} has a non-finite timestamp`)
    }
    const expectedChar = PACED_TYPING_CHARACTERS[(seq - 1) % PACED_TYPING_CHARACTERS.length]
    if (arrival.char !== expectedChar) {
      throw new Error(
        `Typing sample ${seq} received ${JSON.stringify(arrival.char)}, expected ${JSON.stringify(expectedChar)}`
      )
    }
    const dispatchDelay = sentAt - plannedAt
    const plannedToArrival = arrival.atMs - plannedAt
    const plannedToEcho = seenAt - plannedAt
    const inputHalf = arrival.atMs - sentAt
    const echoHalf = seenAt - arrival.atMs
    const total = seenAt - sentAt
    if (
      dispatchDelay < 0 ||
      plannedToArrival < 0 ||
      plannedToEcho < 0 ||
      inputHalf < 0 ||
      echoHalf < 0 ||
      total < 0
    ) {
      throw new Error(
        `Typing sample ${seq} has invalid clock order: planned=${plannedAt}, dispatched=${sentAt}, arrived=${arrival.atMs}, bufferEcho=${seenAt}`
      )
    }
    dispatchDelayMs.push(dispatchDelay)
    plannedToPtyArrivalMs.push(plannedToArrival)
    plannedToBufferEchoMs.push(plannedToEcho)
    inputHalfMs.push(inputHalf)
    echoHalfMs.push(echoHalf)
    totalMs.push(total)
    samples.push({
      seq,
      expectedChar,
      receivedChar: arrival.char,
      plannedAt,
      sentAt,
      ptyArrivedAt: arrival.atMs,
      echoSeenAt: seenAt,
      dispatchDelayMs: dispatchDelay,
      plannedToPtyArrivalMs: plannedToArrival,
      plannedToBufferEchoMs: plannedToEcho
    })
  }

  return {
    dispatchModel: 'absolute-targets-serialized-cdp',
    echoObservation: 'xterm-buffer-poll',
    keyCount: args.keyCount,
    dispatchDelayMs: latencyStats(dispatchDelayMs),
    plannedToPtyArrivalMs: latencyStats(plannedToPtyArrivalMs),
    plannedToBufferEchoMs: latencyStats(plannedToBufferEchoMs),
    totalMs: latencyStats(totalMs),
    inputHalfMs: latencyStats(inputHalfMs),
    echoHalfMs: latencyStats(echoHalfMs),
    maxTimerDriftMs: args.maxTimerDriftMs,
    samples
  }
}

import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'
import type { EnvironmentBuildStep } from './cloud-environment-types'

export const BUILD_STEPS: readonly EnvironmentBuildStep[] = [
  'boot',
  'clone',
  'install',
  'record',
  'snapshot'
]
const SCRIPT_STEPS = new Set<EnvironmentBuildStep>(['clone', 'install', 'record'])

export type LogLineKind = 'plain' | 'warning' | 'error' | 'orca-error'

export type LogLine = {
  id: number
  /** Raw text; may still carry ANSI SGR sequences for colored rendering. */
  text: string
  /** ANSI-stripped text used for search, classification and copy. */
  plain: string
  stream: 'stdout' | 'stderr'
  at: number | null
  kind: LogLineKind
  step: EnvironmentBuildStep
}

const STEP_MARKER = /^::orca-step::\s*([a-z]+)\s*$/
const ORCA_ERROR = /^::orca-error::\s?(.*)$/
// "0 errors", "no errors found", "error-free", "--no-fail" are routine and must not light up red.
const BENIGN_ERROR =
  /\b(?:0|no|zero)\s+(?:errors?|failures?|failed)\b|error[-_]free|--no-fail|\bfailed=0\b/i
const ERROR_LINE =
  /\b(?:error|errors|fatal|failed|failure|panic|exception)\b|ERR!|Traceback \(most recent|^E: /i
// apt-get prefixes errors with `E: ` and warnings with `W: `.
const WARNING_LINE = /\b(?:warn|warning|deprecated)\b|WARN\b|^W: /i

export function parseStepMarker(plain: string): EnvironmentBuildStep | null {
  const match = STEP_MARKER.exec(plain.trim())
  const step = match?.[1] as EnvironmentBuildStep | undefined
  return step && SCRIPT_STEPS.has(step) ? step : null
}

/** Heuristic highlighting; Orca's own `::orca-error::` lines win over everything. */
export function classifyLogLine(plain: string): {
  kind: LogLineKind
  text: string
} {
  const orcaError = ORCA_ERROR.exec(plain)
  if (orcaError) {
    return { kind: 'orca-error', text: orcaError[1] }
  }
  if (ERROR_LINE.test(plain) && !BENIGN_ERROR.test(plain)) {
    return { kind: 'error', text: plain }
  }
  if (WARNING_LINE.test(plain)) {
    return { kind: 'warning', text: plain }
  }
  return { kind: 'plain', text: plain }
}

/** An open (newline-less) line longer than this stops growing; minified output can be megabytes. */
export const MAX_OPEN_LINE_CHARS = 64 * 1024

/**
 * Drop every progress-bar frame before the last non-trailing carriage return, so a line redrawn
 * thousands of times costs O(frame), not O(all frames so far).
 */
export function trimCarriageFrames(raw: string): string {
  const index = raw.lastIndexOf('\r', raw.length - 2)
  return index === -1 ? raw : raw.slice(index + 1)
}

/** A carriage return without a newline redraws the line (progress bars); keep the final frame. */
function lastCarriageFrame(text: string): string {
  const trimmed = text.endsWith('\r') ? text.slice(0, -1) : text
  const index = trimmed.lastIndexOf('\r')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

export type StepMarker = { lineIndex: number; at: number | null }

type Scheduler = (flush: () => void) => void

const defaultScheduler: Scheduler = (flush) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flush)
  } else {
    setTimeout(flush, 16)
  }
}

/**
 * Mutable, append-only log store for one build. Chunks arrive at network speed; React reads a
 * version number via useSyncExternalStore and listeners fire at most once per animation frame.
 */
export class BuildLogBuffer {
  lines: LogLine[] = []
  markers: Partial<Record<EnvironmentBuildStep, StepMarker>> = {}
  orcaErrors: string[] = []
  /** Line indices of `::orca-error::` notes (rendered as callouts, not output lines). */
  orcaErrorLines: number[] = []
  bytes = 0
  private version = 0
  private nextId = 0
  private currentStep: EnvironmentBuildStep = 'boot'
  /** The last line is still open (no trailing newline yet) and belongs to this stream. */
  private open: { stream: 'stdout' | 'stderr'; raw: string } | null = null
  private listeners = new Set<() => void>()
  private flushScheduled = false

  constructor(private readonly schedule: Scheduler = defaultScheduler) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = (): number => this.version

  reset(): void {
    this.lines = []
    this.markers = {}
    this.orcaErrors = []
    this.orcaErrorLines = []
    this.bytes = 0
    this.currentStep = 'boot'
    this.open = null
    this.changed()
  }

  append(stream: 'stdout' | 'stderr', data: string, at?: number): void {
    if (!data) {
      return
    }
    this.bytes += data.length
    const stamp = typeof at === 'number' ? at : null
    let rest = data
    if (this.open && this.open.stream !== stream) {
      // Interleaved streams: the other stream's partial line is final now. Finish it so a partial
      // `::orca-error::` or step marker still registers.
      this.open = null
      this.finishLast()
    }
    if (this.open) {
      const newline = rest.indexOf('\n')
      const piece = newline === -1 ? rest : rest.slice(0, newline)
      const room = MAX_OPEN_LINE_CHARS - this.open.raw.length
      this.replaceLast(
        trimCarriageFrames(this.open.raw + (room > 0 ? piece.slice(0, room) : '')),
        stream
      )
      if (newline === -1) {
        this.changed()
        return
      }
      this.open = null
      this.finishLast()
      rest = rest.slice(newline + 1)
    }
    const parts = rest.split('\n')
    const tail = parts.pop() ?? ''
    for (const raw of parts) {
      this.pushLine(raw, stream, stamp, true)
    }
    if (tail) {
      const raw = trimCarriageFrames(tail).slice(0, MAX_OPEN_LINE_CHARS)
      this.pushLine(raw, stream, stamp, false)
      this.open = { stream, raw }
    }
    this.changed()
  }

  /**
   * Take over another buffer's contents (a reconnect replayed into a shadow buffer); listeners of
   * this one see a single update instead of an empty log refilling.
   */
  adopt(other: BuildLogBuffer): void {
    this.lines = other.lines
    this.markers = other.markers
    this.orcaErrors = other.orcaErrors
    this.orcaErrorLines = other.orcaErrorLines
    this.bytes = other.bytes
    this.nextId = other.nextId
    this.currentStep = other.currentStep
    this.open = other.open
    this.changed()
  }

  /** The stream ended: whatever partial line is left is final. */
  close(): void {
    if (this.open) {
      this.open = null
      this.finishLast()
      this.changed()
    }
  }

  /** Line index ranges per step: lines arrive in step order, so each step is contiguous. */
  stepRange(step: EnvironmentBuildStep): { start: number; end: number } {
    const total = this.lines.length
    if (step === 'snapshot') {
      return { start: total, end: total }
    }
    const order: EnvironmentBuildStep[] = ['boot', 'clone', 'install', 'record']
    const index = order.indexOf(step)
    const start = step === 'boot' ? 0 : this.markers[step]?.lineIndex
    if (start === undefined) {
      return { start: total, end: total }
    }
    let end = total
    for (const later of order.slice(index + 1)) {
      const marker = this.markers[later]
      if (marker) {
        end = marker.lineIndex
        break
      }
    }
    return { start, end }
  }

  /** Output lines in a step, not counting Orca's own error notes. */
  outputLineCount(step: EnvironmentBuildStep): number {
    const { start, end } = this.stepRange(step)
    const notes = this.orcaErrorLines.filter((index) => index >= start && index < end).length
    return end - start - notes
  }

  text(): string {
    const out: string[] = []
    for (const step of BUILD_STEPS) {
      const range = this.stepRange(step)
      if (range.end <= range.start) {
        continue
      }
      out.push(`== ${step} ==`)
      for (let i = range.start; i < range.end; i += 1) {
        const line = this.lines[i]
        out.push(line.kind === 'orca-error' ? `::orca-error:: ${line.plain}` : line.plain)
      }
    }
    return out.join('\n')
  }

  private pushLine(raw: string, stream: 'stdout' | 'stderr', at: number | null, done: boolean) {
    const frame = lastCarriageFrame(raw)
    const plain = stripAnsiEscapeSequences(frame)
    const marker = done ? parseStepMarker(plain) : null
    if (marker) {
      this.currentStep = marker
      this.markers[marker] = { lineIndex: this.lines.length, at }
      return
    }
    const { kind, text } = classifyLogLine(plain)
    if (done && kind === 'orca-error') {
      this.orcaErrors.push(text)
      this.orcaErrorLines.push(this.lines.length)
    }
    this.lines.push({
      id: this.nextId++,
      text: kind === 'orca-error' ? text : frame,
      plain: text,
      stream,
      at,
      kind,
      step: this.currentStep
    })
  }

  private replaceLast(raw: string, stream: 'stdout' | 'stderr'): void {
    const last = this.lines.at(-1)
    if (!last) {
      return
    }
    const frame = lastCarriageFrame(raw)
    const plain = stripAnsiEscapeSequences(frame)
    const { kind, text } = classifyLogLine(plain)
    // New object so memoized rows re-render; ids stay stable for React keys.
    this.lines[this.lines.length - 1] = {
      ...last,
      text: kind === 'orca-error' ? text : frame,
      plain: text,
      kind,
      stream
    }
    if (this.open) {
      this.open.raw = raw
    }
  }

  /** A partial line just got its newline: it may turn out to be a marker or an Orca error. */
  private finishLast(): void {
    const last = this.lines.at(-1)
    if (!last) {
      return
    }
    const marker = parseStepMarker(last.plain)
    if (marker) {
      this.lines.pop()
      this.currentStep = marker
      this.markers[marker] = { lineIndex: this.lines.length, at: last.at }
      return
    }
    if (last.kind === 'orca-error') {
      this.orcaErrors.push(last.plain)
      this.orcaErrorLines.push(this.lines.length - 1)
    }
  }

  private changed(): void {
    if (this.flushScheduled) {
      return
    }
    this.flushScheduled = true
    this.schedule(() => {
      this.flushScheduled = false
      this.version += 1
      for (const listener of this.listeners) {
        listener()
      }
    })
  }
}

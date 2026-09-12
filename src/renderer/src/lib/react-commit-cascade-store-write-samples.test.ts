import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { create } from 'zustand'
import { withReactCommitCascadeWriteProbe } from '../store/react-commit-cascade-write-probe'
import {
  MAX_REPORTED_CHANGED_KEYS,
  MAX_SAMPLED_WRITES,
  armReactCommitCascadeWriteSampling,
  noteReactCommitCascadeStoreWrite,
  readReactCommitCascadeWriteSummary,
  resetReactCommitCascadeWriteSamples
} from './react-commit-cascade-store-write-samples'

// Not an intersection with ErrorConstructor: both fields have to stay optional
// so the absent-captureStackTrace platform can be simulated.
type ErrorWithCapture = {
  captureStackTrace?: (target: object, constructorOpt?: unknown) => void
  stackTraceLimit?: number
}
const errorWithCapture = Error as unknown as ErrorWithCapture
const originalCapture = errorWithCapture.captureStackTrace
const originalLimit = errorWithCapture.stackTraceLimit

/** Stands in for the zustand slice action that calls `set`. */
function storeAction(): void {
  noteReactCommitCascadeStoreWrite(storeAction, { ticks: 1 })
}
function runawayEffect(): void {
  storeAction()
}
function paneRender(): void {
  runawayEffect()
}

beforeEach(() => {
  resetReactCommitCascadeWriteSamples()
})

afterEach(() => {
  resetReactCommitCascadeWriteSamples()
  errorWithCapture.captureStackTrace = originalCapture
  errorWithCapture.stackTraceLimit = originalLimit
})

describe('driver stack frames', () => {
  // Why more than one frame: frame 0 is the slice action every cascade shares.
  // The caller above it is the loop we are actually hunting.
  it('names callers above the frame the write came from', () => {
    armReactCommitCascadeWriteSampling()
    paneRender()

    const summary = readReactCommitCascadeWriteSummary()
    const frames = summary.driverStack?.split('\n') ?? []
    expect(summary.driverFrame).toContain('runawayEffect')
    expect(frames[0]).toBe(summary.driverFrame)
    expect(frames.length).toBeGreaterThan(1)
    expect(summary.driverStack).toContain('paneRender')
    expect(summary.driverFrame).not.toContain('paneRender')
  })

  // Why: the redaction that strips paths is keyed on the detail NAME, so a path
  // inside this value would ship a developer's home directory.
  it('keeps every reported frame path-free', () => {
    armReactCommitCascadeWriteSampling()
    paneRender()

    expect(readReactCommitCascadeWriteSummary().driverStack).not.toContain('/')
  })
})

describe('capture failures', () => {
  // Why asserted: the limit is process-global, so leaking a raised value would
  // make every unrelated throw in the app capture eight frames forever.
  it('restores Error.stackTraceLimit when the capture throws', () => {
    errorWithCapture.stackTraceLimit = 3
    errorWithCapture.captureStackTrace = () => {
      throw new Error('capture refused')
    }
    armReactCommitCascadeWriteSampling()

    expect(() => storeAction()).not.toThrow()
    expect(errorWithCapture.stackTraceLimit).toBe(3)
    expect(readReactCommitCascadeWriteSummary().storeWrites).toBe(1)
  })

  // Why asserted: no sample is ever pushed without captureStackTrace, so a cap
  // bound to samples.length would leave key collection running for the whole
  // cascade on any engine that lacks the API.
  it('stops collecting after the sample cap when captureStackTrace is unavailable', () => {
    delete errorWithCapture.captureStackTrace
    armReactCommitCascadeWriteSampling()
    for (let write = 0; write < 100; write += 1) {
      noteReactCommitCascadeStoreWrite(storeAction, { [`key${write}`]: write })
    }
    // Restored before asserting: vitest builds its own failure stacks with it.
    errorWithCapture.captureStackTrace = originalCapture

    const summary = readReactCommitCascadeWriteSummary()
    expect(summary.storeWrites).toBe(100)
    expect(summary.driverFrame).toBeUndefined()
    expect(summary.storeWriteSites).toBe(0)
    expect(summary.changedKeys?.split(',')).toHaveLength(MAX_SAMPLED_WRITES)
    expect(summary.changedKeys).not.toContain('key99')
    expect(summary.changedKeys?.length).toBeLessThan(240)
  })

  // Why still asserted: one write can change many keys, so the report cap is
  // what keeps the detail inside its 240-char budget.
  it('caps reported changed keys from a single wide write', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`key${index}`, index])
    )
    armReactCommitCascadeWriteSampling()
    noteReactCommitCascadeStoreWrite(storeAction, wide)

    const summary = readReactCommitCascadeWriteSummary()
    expect(summary.changedKeys?.split(',')).toHaveLength(MAX_REPORTED_CHANGED_KEYS)
    expect(summary.changedKeys?.length).toBeLessThan(240)
  })
})

// Why measured through the real middleware: the arming condition is what keeps
// an ordinary write down to one boolean read, and nothing else asserts it end to end.
describe('disarmed cost', () => {
  const WRITE_FLOOD = 10_000

  it('captures no stack across a write flood with no cascade', () => {
    const useFloodStore = create<{ ticks: number }>()(
      withReactCommitCascadeWriteProbe(() => ({ ticks: 0 }))
    )
    let captures = 0
    errorWithCapture.captureStackTrace = (target, boundary) => {
      captures += 1
      originalCapture?.(target, boundary)
    }

    for (let write = 0; write < WRITE_FLOOD; write += 1) {
      useFloodStore.setState({ ticks: write })
    }

    expect(captures).toBe(0)
    expect(useFloodStore.getState().ticks).toBe(WRITE_FLOOD - 1)
    expect(readReactCommitCascadeWriteSummary().storeWrites).toBe(0)
  })
})

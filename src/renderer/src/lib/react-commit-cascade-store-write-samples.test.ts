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

// Both fields must stay optional to simulate platforms without captureStackTrace; ErrorConstructor intersection would require them.
type ErrorWithCapture = {
  captureStackTrace?: (target: { stack?: string }, constructorOpt?: unknown) => void
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
  // Frame zero names the shared slice action; its callers identify the actual loop.
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

  // Redaction keys on detail names; paths inside this value would expose a developer home directory.
  it('keeps every reported frame path-free', () => {
    armReactCommitCascadeWriteSampling()
    paneRender()

    expect(readReactCommitCascadeWriteSummary().driverStack).not.toContain('/')
  })
})

describe('capture failures', () => {
  // Restore the process-global stack limit or unrelated errors retain extra frames.
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

  // Without captureStackTrace, samples.length never grows; cap writes separately or key collection never stops.
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

  // One write can change many keys; report-time limits must preserve the 240-char budget.
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

// Use real middleware to prove ordinary unarmed writes cost only a boolean read.
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

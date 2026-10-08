import { describe, expect, it } from 'vitest'
import { partitionSelfTestLongTask, type LongTaskSample } from './runtime-graph-publication-probe'

// The observer is live from probe start, so setup work lands in the array before
// the injected busy-wait. Index 0 is the decoy a start-time cutoff would accept.
const setupTask: LongTaskSample = { startEpochMs: 1_000, durationMs: 120 }
const selfTestTask: LongTaskSample = { startEpochMs: 5_000, durationMs: 260 }
const workloadTask: LongTaskSample = { startEpochMs: 9_000, durationMs: 80 }

const selfTestWindow = { startEpochMs: 5_005, endEpochMs: 5_255 }

describe('partitionSelfTestLongTask', () => {
  it('attributes the entry the busy-wait ran in, not an earlier one', () => {
    const result = partitionSelfTestLongTask(
      [setupTask, selfTestTask, workloadTask],
      selfTestWindow
    )
    expect(result.selfTestLongTaskMs).toBe(260)
    expect(result.workloadLongTasks).toEqual([setupTask, workloadTask])
  })

  it('leaves the oracle unproven when only unrelated tasks were observed', () => {
    const result = partitionSelfTestLongTask([setupTask, workloadTask], selfTestWindow)
    expect(result.selfTestLongTaskMs).toBe(0)
    expect(result.workloadLongTasks).toEqual([setupTask, workloadTask])
  })

  it('leaves the oracle unproven when a task ends before the busy-wait starts', () => {
    // Touches the window's lower edge but does not reach its midpoint.
    const result = partitionSelfTestLongTask([{ startEpochMs: 4_900, durationMs: 110 }], {
      startEpochMs: 5_000,
      endEpochMs: 5_250
    })
    expect(result.selfTestLongTaskMs).toBe(0)
  })

  it('keeps every task when no self-test ran', () => {
    const result = partitionSelfTestLongTask([setupTask, workloadTask], null)
    expect(result.selfTestLongTaskMs).toBe(0)
    expect(result.workloadLongTasks).toEqual([setupTask, workloadTask])
  })

  it('removes only the matched entry when another has identical values', () => {
    const twin: LongTaskSample = { ...selfTestTask }
    const result = partitionSelfTestLongTask([selfTestTask, twin], selfTestWindow)
    expect(result.workloadLongTasks).toHaveLength(1)
    expect(result.workloadLongTasks[0]).toBe(twin)
  })

  it('rounds the reported duration to one decimal', () => {
    const result = partitionSelfTestLongTask(
      [{ startEpochMs: 5_000, durationMs: 251.2649 }],
      selfTestWindow
    )
    expect(result.selfTestLongTaskMs).toBe(251.3)
  })
})

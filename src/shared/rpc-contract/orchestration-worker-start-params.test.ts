/**
 * A `--max-load` present on the wire must be a positive ratio, never silently dropped.
 *
 * The host load gate only exists if `maxLoad` survives parsing: a caller that sends `"0.7"`,
 * `NaN`, or `Infinity` and reaches the handler as `undefined` gets no gate at all.
 */

import { describe, expect, it } from 'vitest'
import { WorkerStartParams } from './orchestration-worker-start-params'

const BASE = { task: 'task_1', from: 'term_coord' }

describe('orchestration.workerStart maxLoad params', () => {
  it('parses an omitted --max-load to undefined, meaning no gate', () => {
    const parsed = WorkerStartParams.safeParse(BASE)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.maxLoad).toBeUndefined()
  })

  it('parses a positive ratio as the number the gate compares', () => {
    const parsed = WorkerStartParams.safeParse({ ...BASE, maxLoad: 0.7 })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.maxLoad).toBe(0.7)
  })

  it.each(['0.7', Number.NaN, Number.POSITIVE_INFINITY, 0, -1, null])(
    'refuses a present --max-load %j instead of dropping it',
    (maxLoad) => {
      const parsed = WorkerStartParams.safeParse({ ...BASE, maxLoad })
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ['maxLoad'],
          message: '--max-load must be a positive ratio of 1-minute load average to CPU cores'
        })
      )
    }
  )
})

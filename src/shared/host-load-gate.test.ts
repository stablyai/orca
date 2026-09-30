import { describe, expect, it } from 'vitest'
import { evaluateHostLoadGate, hostLoadExceededMessage, isValidMaxLoad } from './host-load-gate'

describe('host load gate', () => {
  it('passes while the per-core load stays at or below the limit', () => {
    expect(evaluateHostLoadGate({ cpuCoreCount: 8, loadAverage1m: 5.6 }, 0.7).exceeded).toBe(false)
    expect(evaluateHostLoadGate({ cpuCoreCount: 8, loadAverage1m: 2 }, 0.7).exceeded).toBe(false)
  })

  it('refuses once the per-core load rises above the limit', () => {
    const verdict = evaluateHostLoadGate({ cpuCoreCount: 8, loadAverage1m: 12 }, 0.7)
    expect(verdict).toEqual({
      cpuCoreCount: 8,
      loadAverage1m: 12,
      loadRatio: 1.5,
      maxLoad: 0.7,
      exceeded: true
    })
    expect(hostLoadExceededMessage(verdict)).toBe(
      'Host load 1.50 per core (1-minute average 12.00 on 8 cores) exceeds --max-load 0.7. No effects were applied.'
    )
  })

  it('never divides by zero and treats an unreadable load as idle', () => {
    expect(evaluateHostLoadGate({ cpuCoreCount: 0, loadAverage1m: 3 }, 1)).toMatchObject({
      cpuCoreCount: 1,
      loadRatio: 3,
      exceeded: true
    })
    // Why: Windows reports [0, 0, 0] for the load average, so the gate must stay open there.
    expect(evaluateHostLoadGate({ cpuCoreCount: 4, loadAverage1m: 0 }, 0.1).exceeded).toBe(false)
    expect(evaluateHostLoadGate({ cpuCoreCount: 4, loadAverage1m: Number.NaN }, 0.1)).toMatchObject(
      { loadAverage1m: 0, exceeded: false }
    )
  })

  it('accepts only a finite positive ratio', () => {
    expect(isValidMaxLoad(0.7)).toBe(true)
    expect(isValidMaxLoad(2)).toBe(true)
    expect(isValidMaxLoad(0)).toBe(false)
    expect(isValidMaxLoad(-1)).toBe(false)
    expect(isValidMaxLoad(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isValidMaxLoad('0.7')).toBe(false)
  })
})

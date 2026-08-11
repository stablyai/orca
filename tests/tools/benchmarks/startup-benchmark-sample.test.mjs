import { describe, expect, it } from 'vitest'
import {
  assertValidStartupBenchmarkSample,
  normalizeStartupBenchmarkOutcome
} from './startup-benchmark-sample.mjs'

function sample(overrides = {}) {
  return {
    outcome: 'ok',
    gracefulShutdownRequested: true,
    exitCode: 0,
    exitSignal: null,
    ...overrides
  }
}

describe('startup benchmark sample validity', () => {
  it('accepts only graceful zero-code exits without a signal', () => {
    const result = sample()

    expect(normalizeStartupBenchmarkOutcome(result)).toBe('ok')
    expect(() => assertValidStartupBenchmarkSample(result)).not.toThrow()
  })

  it('rejects a nonzero child exit with actionable metadata', () => {
    const result = sample({ exitCode: 7 })

    expect(normalizeStartupBenchmarkOutcome(result)).toBe('nonzero-exit')
    expect(() => assertValidStartupBenchmarkSample(result)).toThrow(
      'outcome=nonzero-exit, gracefulShutdownRequested=true, exitCode=7, exitSignal=null'
    )
  })

  it('rejects a signaled child exit with actionable metadata', () => {
    const result = sample({ exitCode: null, exitSignal: 'SIGTERM' })

    expect(normalizeStartupBenchmarkOutcome(result)).toBe('signal-exit')
    expect(() => assertValidStartupBenchmarkSample(result)).toThrow(
      'outcome=signal-exit, gracefulShutdownRequested=true, exitCode=null, exitSignal=SIGTERM'
    )
  })

  it('rejects a sample taken before graceful shutdown was requested', () => {
    const result = sample({ gracefulShutdownRequested: false })

    expect(normalizeStartupBenchmarkOutcome(result)).toBe('graceful-shutdown-not-requested')
    expect(() => assertValidStartupBenchmarkSample(result)).toThrow(
      'outcome=graceful-shutdown-not-requested, gracefulShutdownRequested=false, exitCode=0, exitSignal=null'
    )
  })
})

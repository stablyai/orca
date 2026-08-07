// P2.3 tests — continuous calibrated verifier + GroundedScoreCalculator.
// These encode the paper's core moves: read scoring-token LOGITS (not a
// pass/fail flag), calibrate the raw softmax into an interpretable
// probability, and anchor a grounded continuous score on 1.0 == verified.

import { describe, expect, it } from 'vitest'
import { CLEAN_TOKEN, ContinuousVerifier, plattCalibration } from './continuous-verifier'
import { GroundedScoreCalculator } from './grounded-score-calculator'
import type { VerificationSignalInput } from './continuous-verifier'

const verifier = new ContinuousVerifier()

function sig(overrides: Partial<VerificationSignalInput> = {}): VerificationSignalInput {
  return {
    id: overrides.id ?? 'a',
    family: overrides.family ?? 'terminal',
    label: overrides.label ?? 'a',
    logits: overrides.logits ?? { [CLEAN_TOKEN]: 2, dirty: -3 },
    reason: overrides.reason
  }
}

describe('ContinuousVerifier — reads scoring-token logits', () => {
  it('returns the softmax probability of the clean token', () => {
    const raw = verifier.rawScoreFromLogits({ [CLEAN_TOKEN]: 2, dirty: -3 })
    // softmax([2,-3]) for clean = e^2 / (e^2 + e^-3)
    const expected = Math.exp(2) / (Math.exp(2) + Math.exp(-3))
    expect(raw).toBeCloseTo(expected, 10)
    expect(raw).toBeGreaterThan(0.99)
  })

  it('treats a dirty-dominant logit vector as low cleanliness', () => {
    const raw = verifier.rawScoreFromLogits({ [CLEAN_TOKEN]: -3, dirty: 2 })
    expect(raw).toBeLessThan(0.01)
  })

  it('returns max-entropy 0.5 when there is no clean token', () => {
    expect(verifier.rawScoreFromLogits({ dirty: 1, unknown: 0 })).toBe(0.5)
  })

  it('returns 0.5 for an empty logit set (no verifier signal)', () => {
    expect(verifier.rawScoreFromLogits({})).toBe(0.5)
  })

  it('produces a calibrated signal and a derived boolean gate', () => {
    const s = verifier.fromLogits(sig({ logits: { [CLEAN_TOKEN]: 2, dirty: -3 } }))
    expect(s.raw).toBeGreaterThan(0.99)
    expect(s.calibrated).toBeCloseTo(s.raw, 10) // identity calibration
    expect(s.verified).toBe(true)
    expect(s.threshold).toBe(0.5)
  })

  it('temperature sharpens the softmax (higher temp → closer to 0.5)', () => {
    const cold = new ContinuousVerifier({ temperature: 0.1 })
    const hot = new ContinuousVerifier({ temperature: 10 })
    const logits = { [CLEAN_TOKEN]: 4, dirty: -4 }
    expect(cold.rawScoreFromLogits(logits)).toBeGreaterThan(hot.rawScoreFromLogits(logits))
    expect(hot.rawScoreFromLogits(logits)).toBeGreaterThan(0.5)
    expect(hot.rawScoreFromLogits(logits)).toBeLessThan(cold.rawScoreFromLogits(logits))
  })
})

describe('Platt calibration', () => {
  it('identity calibration leaves raw unchanged', () => {
    const v = new ContinuousVerifier({ calibration: { kind: 'identity', a: 1, b: 0, calibrate: (r) => r } })
    const s = v.fromLogits(sig({ logits: { [CLEAN_TOKEN]: 0, dirty: 0 } }))
    expect(s.calibrated).toBeCloseTo(0.5, 10)
  })

  it('Platt scaling maps the raw probability through a logistic', () => {
    const cal = plattCalibration(2, 0)
    const v = new ContinuousVerifier({ calibration: cal })
    const s = v.fromLogits(sig({ logits: { [CLEAN_TOKEN]: 1, dirty: 1 } })) // raw 0.5
    // calibrate(0.5) = 1 / (1 + exp(-(2*0.5 + 0))) = 1 / (1 + exp(-1)) ≈ 0.731
    const expected = 1 / (1 + Math.exp(-(2 * 0.5)))
    expect(s.calibrated).toBeCloseTo(expected, 10)
    expect(s.calibrated).toBeGreaterThan(0.5)
  })
})

describe('GroundedScoreCalculator — grounded continuous verdict', () => {
  it('scores fully verified (no signals) at 1.0 and the gate passes', () => {
    const calc = new GroundedScoreCalculator()
    const result = calc.compute([], { overallThreshold: 1.0 })
    expect(result.score).toBe(1)
    expect(result.verified).toBe(true)
    expect(result.worst).toBeNull()
  })

  it('product of family means keeps every leak-core semantics continuous', () => {
    const calc = new GroundedScoreCalculator()
    // terminal clean≈0.018, worktree clean≈0.881 (logits 1/-1 → 1/(1+e^-2))
    const signals = [
      verifier.fromLogits(sig({ id: 't1', family: 'terminal', logits: { [CLEAN_TOKEN]: -2, dirty: 2 } })),
      verifier.fromLogits(sig({ id: 'w1', family: 'worktree', logits: { [CLEAN_TOKEN]: 1, dirty: -1 } }))
    ]
    const result = calc.compute(signals, { overallThreshold: 1.0 })
    expect(result.families.terminal.score).toBeCloseTo(0.018, 2) // softmax([−2,2]) clean = 1/(1+e^4)
    expect(result.families.worktree.score).toBeCloseTo(0.881, 3) // softmax([1,−1]) clean = 1/(1+e^-2)
    expect(result.score).toBeCloseTo(result.families.terminal.score * result.families.worktree.score, 9)
    expect(result.verified).toBe(false)
    expect(result.worst?.id).toBe('t1')
  })

  it('a scan error forces scanCompleteness 0 → overall score 0, gate fails', () => {
    const calc = new GroundedScoreCalculator()
    const result = calc.compute([], { cliErrors: { daemonScan: 'scan failed' } })
    expect(result.scanCompleteness).toBe(0)
    expect(result.score).toBe(0)
    expect(result.verified).toBe(false)
  })

  it('monotonic in cleanliness: a worse terminal drops the score', () => {
    const calc = new GroundedScoreCalculator()
    const make = (cleanLogit: number) => {
      const s = verifier.fromLogits(
        sig({ id: 't', family: 'terminal', logits: { [CLEAN_TOKEN]: cleanLogit, dirty: -cleanLogit } })
      )
      return calc.compute([s], { overallThreshold: 1.0 }).score
    }
    expect(make(3)).toBeGreaterThan(make(1))
    expect(make(1)).toBeGreaterThan(make(-1))
  })

  it('bit-for-bit compatible with old healthy gate at threshold 1', () => {
    // Old: healthy = counts === 0. New: verified = score >= 1 - eps.
    // Any leak signal has calibrated < 1, so score < 1, so verified === false.
    const calc = new GroundedScoreCalculator()
    const leaky = calc.compute(
      [verifier.fromLogits(sig({ id: 'l', family: 'worktree', logits: { [CLEAN_TOKEN]: 1, dirty: 0 } }))],
      { overallThreshold: 1.0 }
    )
    expect(leaky.verified).toBe(false)
    const clean = calc.compute([], { overallThreshold: 1.0 })
    expect(clean.verified).toBe(true)
  })
})

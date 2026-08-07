// P2.5 tests — Minimum Viable Validation Protocol for the internal LLM-judge.
// Encodes the paper's core move: replace bare exact-match agreement with
// chance-corrected Cohen's kappa, plus consistency (test–retest) and bias
// (position/verbosity) companion protocols.

import { describe, expect, it } from 'vitest'
import {
  auditBinaryJudges,
  auditJudgeMvvp,
  MINIMUM_VIABLE_KAPPA,
  positionBiasAudit,
  testRetestAudit,
  verbosityBiasAudit
} from './judge-reliability'
import {
  cohensKappa,
  exactMatchAgreement,
  interpretKappa,
  quadraticWeightedKappa
} from './kappa'

describe('exactMatchAgreement — the metric the paper warns against', () => {
  it('returns 1 for identical raters', () => {
    expect(exactMatchAgreement([true, false, true], [true, false, true])).toBe(1)
  })
  it('throws when raters scored different item counts', () => {
    expect(() => exactMatchAgreement([true], [true, false])).toThrow()
  })
})

describe('cohensKappa — chance-corrected reliability', () => {
  it('is 1.0 when both raters agree perfectly', () => {
    const { kappa } = cohensKappa([true, false, true, false], [true, false, true, false])
    expect(kappa).toBeCloseTo(1, 10)
  })

  it('corrects for chance: a constant judge vs a balanced gold is NEGATIVE', () => {
    // Gold is 50/50; the judge always says TRUE. Agrees half the time by
    // chance alone, and its marginals diverge from gold.
    const gold = [true, false, true, false, true, false, true, false, true, false]
    const constantJudge = [true, true, true, true, true, true, true, true, true, true]
    const { observedAgreement, kappa } = cohensKappa(constantJudge, gold)
    expect(observedAgreement).toBeCloseTo(0.5, 10)
    expect(kappa).toBeLessThan(0) // worse than chance — the whole point
  })

  it('deflation trap: 90% raw agreement can still be ~chance (kappa ~ 0)', () => {
    // Imbalanced gold (9/10 true). A judge that always says TRUE hits 90%
    // agreement but its kappa is essentially chance-level.
    const gold = [true, true, true, true, true, true, true, true, true, false]
    const judge = [true, true, true, true, true, true, true, true, true, true]
    const { observedAgreement, kappa } = cohensKappa(judge, gold)
    expect(observedAgreement).toBeCloseTo(0.9, 10)
    expect(kappa).toBeLessThan(0.1) // barely above chance despite 90% agreement
    const audit = auditBinaryJudges(judge, gold)
    expect(audit.observedAgreement).toBeGreaterThanOrEqual(0.8)
    expect(audit.kappa).toBeLessThan(MINIMUM_VIABLE_KAPPA)
    expect(audit.deflated).toBe(true) // the paper's kappa-deflation signal
    expect(audit.passes).toBe(false)
  })

  it('produces a kappa in [-1,1] for a noisy judge', () => {
    const a = [true, true, false, false, true, false, true, false, true, true, false, true]
    const b = [true, false, false, true, true, false, true, true, false, true, false, true]
    const { kappa } = cohensKappa(a, b)
    expect(kappa).toBeGreaterThanOrEqual(-1)
    expect(kappa).toBeLessThanOrEqual(1)
  })
})

describe('interpretKappa — Landis & Koch bands', () => {
  it('maps the canonical bands', () => {
    expect(interpretKappa(-0.1)).toBe('poor')
    expect(interpretKappa(0.1)).toBe('slight')
    expect(interpretKappa(0.3)).toBe('fair')
    expect(interpretKappa(0.5)).toBe('moderate')
    expect(interpretKappa(0.7)).toBe('substantial')
    expect(interpretKappa(0.9)).toBe('almost-perfect')
    expect(interpretKappa(1)).toBe('perfect')
  })
})

describe('quadraticWeightedKappa — ordinal ratings', () => {
  it('is 1.0 when the ordinal ratings are identical', () => {
    expect(quadraticWeightedKappa([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 10)
  })
  it('stays in [-1,1] for reversed ratings', () => {
    const k = quadraticWeightedKappa([1, 2, 3, 4], [4, 3, 2, 1])
    expect(k).toBeGreaterThanOrEqual(-1)
    expect(k).toBeLessThanOrEqual(1)
  })
})

describe('testRetestAudit — consistency protocol', () => {
  it('passes when the judge is reproducible across two runs', () => {
    const run1 = [
      { calibrated: 0.9, verified: true },
      { calibrated: 0.2, verified: false },
      { calibrated: 0.85, verified: true }
    ]
    const run2 = [
      { calibrated: 0.88, verified: true },
      { calibrated: 0.22, verified: false },
      { calibrated: 0.83, verified: true }
    ]
    const audit = testRetestAudit(run1, run2)
    expect(audit.kappa).toBeCloseTo(1, 10)
    expect(Math.abs(audit.pearsonR)).toBeGreaterThan(0.95)
    expect(audit.passes).toBe(true)
  })
})

describe('positionBiasAudit — bias protocol', () => {
  it('flags severe position bias (delta > 0.1 per the paper)', () => {
    const items = Array.from({ length: 10 }, () => ({ pos1Score: 0.8, pos2Score: 0.5 }))
    const audit = positionBiasAudit(items)
    expect(audit.biasDelta).toBeCloseTo(0.3, 10)
    expect(audit.passes).toBe(false)
  })
  it('passes when order does not change the score', () => {
    const items = Array.from({ length: 10 }, () => ({ pos1Score: 0.6, pos2Score: 0.6 }))
    expect(positionBiasAudit(items).passes).toBe(true)
  })
})

describe('verbosityBiasAudit — bias protocol', () => {
  it('flags verbosity bias when score tracks answer length', () => {
    const items = [
      { length: 10, score: 0.2 },
      { length: 50, score: 0.3 },
      { length: 200, score: 0.9 },
      { length: 400, score: 0.95 }
    ]
    const audit = verbosityBiasAudit(items)
    expect(Math.abs(audit.pearsonR)).toBeGreaterThan(0.1)
    expect(audit.passes).toBe(false)
  })
})

describe('auditJudgeMvvp — the Minimum Viable Validation Protocol', () => {
  it('fails a judge that looks safe on raw agreement but is chance-level', () => {
    const judge = [true, true, true, true, true, true, true, true, true, true]
    const gold = [true, true, true, true, true, true, true, true, true, false]
    const result = auditJudgeMvvp({ judgeDecisions: judge, gold })
    expect(result.agreement.deflated).toBe(true)
    expect(result.passes).toBe(false)
  })

  it('passes a discriminating judge that agrees with gold and re-tests', () => {
    const judge = [true, false, true, false, true, true, false, true, false, true]
    const gold = [true, false, true, false, true, true, false, true, false, true]
    const retest = judge.map((v) => ({ calibrated: v ? 0.9 : 0.1, verified: v }))
    const result = auditJudgeMvvp({ judgeDecisions: judge, gold, retestRun1: retest, retestRun2: retest })
    expect(result.agreement.passes).toBe(true)
    expect(result.consistency.passes).toBe(true)
    expect(result.passes).toBe(true)
  })

  it('requires ALL protocols: a consistent-but-position-biased judge FAILS', () => {
    // Consistent and kappa-clean on agreement, but severe position bias.
    const judge = [true, false, true, false, true, true, false, true, false, true]
    const gold = judge
    const retest = judge.map((v) => ({ calibrated: v ? 0.9 : 0.1, verified: v }))
    const positionBiasItems = Array.from({ length: 10 }, () => ({ pos1Score: 0.9, pos2Score: 0.3 }))
    const result = auditJudgeMvvp({
      judgeDecisions: judge,
      gold,
      retestRun1: retest,
      retestRun2: retest,
      positionBiasItems
    })
    expect(result.agreement.passes).toBe(true)
    expect(result.consistency.passes).toBe(true)
    expect(result.positionBias.passes).toBe(false) // the consistency–bias paradox
    expect(result.passes).toBe(false)
  })
})

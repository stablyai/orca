// P2.5 — Minimum Viable Validation Protocol for the internal LLM-judge
// (paper: Reliability without Validity, 2606.19544). Audits the judge
// components (ContinuousVerifier / GroundedScoreCalculator in this folder)
// with the paper's three protocols: (1) chance-corrected agreement (Cohen's
// kappa, replacing naive exact-match agreement), (2) consistency (test–
// retest), and (3) a bias audit (position + verbosity). A judge passes ONLY if
// all three pass — the paper's point is that no single protocol suffices
// (consistency can coexist with severe bias: the consistency–bias paradox).
//
// This module is pure and dependency-free so it can run in CI as an offline
// audit. It does NOT change the doctor's bit-for-bit `verified` contract; it
// validates the judge that produces that verdict.

import { cohensKappa, interpretKappa, type KappaBand } from './kappa'

/** The MVVP acceptance floor for the agreement protocol. "Substantial"
 *  agreement (>= 0.6) is the recommended cut; a judge below this fails even if
 *  its raw agreement looks reassuring. */
export const MINIMUM_VIABLE_KAPPA = 0.6

export type JudgeAgreementAudit = {
  n: number
  /** Observed exact-match agreement — the naive metric the paper flags. */
  observedAgreement: number
  /** Agreement expected by chance from the label marginals. */
  expectedAgreement: number
  /** Cohen's kappa — the chance-corrected reliability. */
  kappa: number
  /** Landis & Koch band for `kappa`. */
  band: KappaBand
  /** True when raw agreement looks safe (>= 0.8) but kappa is below the floor
   *  — the paper's "kappa deflation" trap (barely better than chance). */
  deflated: boolean
  /** Acceptance gate: kappa >= the MVVP floor. */
  passes: boolean
}

/** Audit two judges' binary decisions (e.g. `verified` gate vs. a gold label,
 *  or judge A vs. judge B). Replaces "does it agree X% of the time?" with "is
 *  its kappa at or above the MVVP floor?". */
export function auditBinaryJudges(
  judgeA: readonly boolean[],
  judgeB: readonly boolean[],
  opts: { minKappa?: number } = {}
): JudgeAgreementAudit {
  const minKappa = opts.minKappa ?? MINIMUM_VIABLE_KAPPA
  const { observedAgreement, expectedAgreement, kappa } = cohensKappa(judgeA, judgeB)
  return {
    n: judgeA.length,
    observedAgreement,
    expectedAgreement,
    kappa,
    band: interpretKappa(kappa),
    deflated: observedAgreement >= 0.8 && kappa < minKappa,
    passes: kappa >= minKappa
  }
}

/** Audit the verifier's `verified` gate against gold labels (human ratings, a
 *  reference judge, or a held-out rubric). */
export function auditVerifierAgainstGold(
  signals: readonly { verified: boolean }[],
  gold: readonly boolean[],
  opts: { minKappa?: number } = {}
): JudgeAgreementAudit {
  return auditBinaryJudges(
    signals.map((s) => s.verified),
    gold,
    opts
  )
}

export type ConsistencyAudit = {
  n: number
  /** Pearson correlation of the continuous scores across the two runs. */
  pearsonR: number
  /** Cohen's kappa on the derived boolean gates across the two runs. */
  kappa: number
  band: KappaBand
  /** Passes when continuous scores are stable (|r| high) AND the gate is
   *  reproducible (kappa >= MVVP floor). */
  passes: boolean
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  if (n === 0) {
    return 1
  }
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma
    const xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da === 0 || db === 0) {
    return 1 // no variance on one side → trivially "stable"
  }
  return num / Math.sqrt(da * db)
}

/** Consistency protocol: run the judge twice on the SAME items and check the
 *  verdict is reproducible. A judge can be consistent yet biased, so this
 *  protocol alone is never sufficient. */
export function testRetestAudit(
  run1: readonly { calibrated: number; verified: boolean }[],
  run2: readonly { calibrated: number; verified: boolean }[],
  opts: { minKappa?: number; minPearson?: number } = {}
): ConsistencyAudit {
  const minKappa = opts.minKappa ?? MINIMUM_VIABLE_KAPPA
  const minPearson = opts.minPearson ?? 0.95
  const { kappa } = cohensKappa(
    run1.map((r) => r.verified),
    run2.map((r) => r.verified)
  )
  const r = pearson(
    run1.map((rr) => rr.calibrated),
    run2.map((rr) => rr.calibrated)
  )
  return {
    n: run1.length,
    pearsonR: r,
    kappa,
    band: interpretKappa(kappa),
    passes: kappa >= minKappa && Math.abs(r) >= minPearson
  }
}

export type PositionBiasAudit = {
  n: number
  /** Mean score delta when the first-listed candidate sits in position 1 vs.
   *  position 2. Positive => the judge favours the first position. */
  biasDelta: number
  /** Passes when |biasDelta| <= cap (paper: > 0.10 is severe). */
  passes: boolean
}

/** Position-bias audit for pairwise judging. Each item is scored twice: once
 *  with candidate X in position 1, once in position 2. The bias is the mean
 *  score gain from being first-listed. */
export function positionBiasAudit(
  items: readonly { pos1Score: number; pos2Score: number }[],
  cap = 0.1
): PositionBiasAudit {
  const n = items.length
  if (n === 0) {
    return { n: 0, biasDelta: 0, passes: true }
  }
  const biasDelta = items.reduce((s, it) => s + (it.pos1Score - it.pos2Score), 0) / n
  return { n, biasDelta, passes: Math.abs(biasDelta) <= cap }
}

export type VerbosityBiasAudit = {
  n: number
  /** Pearson correlation between reference/answer length and the judge score. */
  pearsonR: number
  /** Passes when |pearsonR| <= cap (paper: verbosity bias is small, < 0.011). */
  passes: boolean
}

/** Verbosity-bias audit: does the judge reward longer answers regardless of
 *  quality? Correlates answer length with the judge score. */
export function verbosityBiasAudit(
  items: readonly { length: number; score: number }[],
  cap = 0.1
): VerbosityBiasAudit {
  const n = items.length
  if (n === 0) {
    return { n: 0, pearsonR: 0, passes: true }
  }
  const r = pearson(
    items.map((it) => it.length),
    items.map((it) => it.score)
  )
  return { n, pearsonR: r, passes: Math.abs(r) <= cap }
}

export type MvvpAudit = {
  agreement: JudgeAgreementAudit
  consistency: ConsistencyAudit
  positionBias: PositionBiasAudit
  verbosityBias: VerbosityBiasAudit
  /** Passes ONLY if all three protocols pass (consistency can coexist with
   *  severe bias). */
  passes: boolean
  minKappa: number
}

/** Assemble the Minimum Viable Validation Protocol from the three protocols.
 *  Consistency needs TWO independent runs (`retestRun1`, `retestRun2`); if not
 *  supplied it is reported vacuously passing so callers always see a full
 *  report. */
export function auditJudgeMvvp(args: {
  judgeDecisions: readonly boolean[]
  gold: readonly boolean[]
  retestRun1?: readonly { calibrated: number; verified: boolean }[]
  retestRun2?: readonly { calibrated: number; verified: boolean }[]
  positionBiasItems?: readonly { pos1Score: number; pos2Score: number }[]
  verbosityItems?: readonly { length: number; score: number }[]
  minKappa?: number
}): MvvpAudit {
  const minKappa = args.minKappa ?? MINIMUM_VIABLE_KAPPA
  const agreement = auditBinaryJudges(args.judgeDecisions, args.gold, { minKappa })
  const r1 = args.retestRun1
  const r2 = args.retestRun2
  const hasRetest = r1 !== undefined && r2 !== undefined && r1.length === r2.length
  const consistency: ConsistencyAudit = hasRetest
    ? testRetestAudit(r1, r2, { minKappa })
    : { n: 0, pearsonR: 1, kappa: 1, band: 'perfect', passes: true }
  const positionBias = args.positionBiasItems
    ? positionBiasAudit(args.positionBiasItems)
    : { n: 0, biasDelta: 0, passes: true }
  const verbosityBias = args.verbosityItems
    ? verbosityBiasAudit(args.verbosityItems)
    : { n: 0, pearsonR: 0, passes: true }
  return {
    agreement,
    consistency,
    positionBias,
    verbosityBias,
    passes: agreement.passes && consistency.passes && positionBias.passes && verbosityBias.passes,
    minKappa
  }
}

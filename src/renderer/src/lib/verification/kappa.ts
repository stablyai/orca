// P2.5 — chance-corrected agreement math for LLM-judge reliability audits
// (paper: Reliability without Validity, 2606.19544). Pure, dependency-free
// statistics: Cohen's kappa (nominal), quadratic-weighted kappa (ordinal),
// Landis & Koch band interpretation, and naive exact-match agreement (kept
// only so an audit can surface the kappa-deflation gap, not hide it).
//
// WHY this exists: the paper shows LLM-as-a-Judge validation in practice
// relies on exact-match agreement, a metric that does NOT correct for chance
// and systematically overstates discriminative ability (kappa-deflation of
// 33–41 pp on MT-Bench). Chance-corrected kappa is the replacement.

/** Landis & Koch (1977) interpretation bands for Cohen's kappa. */
export type KappaBand =
  | 'poor'
  | 'slight'
  | 'fair'
  | 'moderate'
  | 'substantial'
  | 'almost-perfect'
  | 'perfect'

export function interpretKappa(kappa: number): KappaBand {
  if (kappa < 0) {
    return 'poor'
  }
  if (kappa <= 0.2) {
    return 'slight'
  }
  if (kappa <= 0.4) {
    return 'fair'
  }
  if (kappa <= 0.6) {
    return 'moderate'
  }
  if (kappa <= 0.8) {
    return 'substantial'
  }
  if (kappa < 1) {
    return 'almost-perfect'
  }
  return 'perfect'
}

/** Naive exact-match agreement — the metric the paper warns against using
 *  alone. Kept so the audit can show the kappa-deflation gap, not hide it. */
export function exactMatchAgreement<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length !== b.length) {
    throw new Error('exactMatchAgreement: raters must score the same items')
  }
  if (a.length === 0) {
    return 1
  }
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) {
      matches++
    }
  }
  return matches / a.length
}

export type KappaResult = {
  observedAgreement: number
  expectedAgreement: number
  kappa: number
}

/** Cohen's kappa for two nominal raters. Chance-corrected:
 *    kappa = (Po - Pe) / (1 - Pe)
 *  where Po is observed agreement and Pe is agreement expected by chance from
 *  the label marginals. */
export function cohensKappa(
  labelsA: readonly (string | boolean | number)[],
  labelsB: readonly (string | boolean | number)[]
): KappaResult {
  if (labelsA.length !== labelsB.length) {
    throw new Error('cohensKappa: raters must score the same items')
  }
  const n = labelsA.length
  if (n === 0) {
    return { observedAgreement: 1, expectedAgreement: 1, kappa: 1 }
  }

  const key = (v: string | boolean | number) => String(v)
  const marginal = new Map<string, number>()
  for (const v of [...labelsA, ...labelsB]) {
    const k = key(v)
    marginal.set(k, (marginal.get(k) ?? 0) + 1)
  }
  let po = 0
  for (let i = 0; i < n; i++) {
    if (key(labelsA[i]) === key(labelsB[i])) {
      po++
    }
  }

  let pe = 0
  for (const count of marginal.values()) {
    const p = count / (2 * n)
    pe += p * p
  }
  const observedAgreement = po / n
  const kappa = pe === 1 ? 1 : (observedAgreement - pe) / (1 - pe)
  return { observedAgreement, expectedAgreement: pe, kappa }
}

/** Quadratic-weighted kappa for ORDINAL ratings (e.g. the verifier's
 *  continuous `calibrated` score bucketed, or Likert-style judge grades).
 *  Penalises disagreements by the square of their distance, chance-corrected.
 *  Returns a value in [-1, 1]; 1 means perfect ordinal agreement. */
export function quadraticWeightedKappa(
  ratingsA: readonly number[],
  ratingsB: readonly number[]
): number {
  if (ratingsA.length !== ratingsB.length) {
    throw new Error('quadraticWeightedKappa: raters must score the same items')
  }
  const n = ratingsA.length
  if (n === 0) {
    return 1
  }

  const levels = new Set<number>()
  for (let i = 0; i < n; i++) {
    levels.add(ratingsA[i])
    levels.add(ratingsB[i])
  }
  const cats = [...levels].sort((x, y) => x - y)
  const k = cats.length
  if (k === 1) {
    return 1 // both raters emitted a single value → no disagreement
  }

  const idx = new Map(cats.map((c, i) => [c, i]))
  const O: number[][] = Array<number>(k)
    .fill(0)
    .map(() => Array<number>(k).fill(0))
  for (let i = 0; i < n; i++) {
    O[idx.get(ratingsA[i]) as number][idx.get(ratingsB[i]) as number]++
  }

  const wA = Array<number>(k).fill(0)
  const wB = Array<number>(k).fill(0)
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < n; j++) {
      if (ratingsA[j] === cats[i]) {
        wA[i]++
      }
      if (ratingsB[j] === cats[i]) {
        wB[i]++
      }
    }
  }
  const E: number[][] = Array<number>(k)
    .fill(0)
    .map(() => Array<number>(k).fill(0))
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      E[i][j] = (wA[i] * wB[j]) / n
    }
  }

  const W: number[][] = Array<number>(k)
    .fill(0)
    .map(() => Array<number>(k).fill(0))
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      W[i][j] = ((i - j) * (i - j)) / ((k - 1) * (k - 1))
    }
  }

  let num = 0
  let den = 0
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      num += W[i][j] * O[i][j]
      den += W[i][j] * E[i][j]
    }
  }
  if (den === 0) {
    return 1
  }
  return 1 - num / den
}

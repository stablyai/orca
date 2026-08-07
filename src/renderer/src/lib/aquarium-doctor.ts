// GREEN-PHASE: `Run doctor` verdict lib (renderer side). Ports the spike's
// doctorScan CONTRACT onto the SAME live sources the Aquarium panel already
// renders (T8 close-out live data + T9 daemon rejoin), so the panel can answer
// "is this machine leaking right now?" without a second, parallel scan surface.
//
// Why renderer-side (not a new main-process scan): every family the doctor
// classifies already has a live source wired into the panel —
//   - terminals: orphan (dead-PTY) tab detection (lib/aquarium-live.ts)
//   - worktrees: the product's own workspace-cleanup scan (candidates)
//   - daemons:   the main-process daemon inventory (T9, daemonInventory:scan)
// Building a NEW main-process doctor that re-runs the same families would
// duplicate heuristics and risk diverging from what the panel shows. The
// verdict is computed from the exact same mapping the panel renders, so
// "Run doctor" always agrees with the visible inventory.
//
// Contract (mirrors the spike's aquarium-doctor.mjs, 11/11):
//   healthy = no class-2/3 terminals, no dead worktrees, no stale daemons,
//   AND no cli errors (a machine we couldn't fully scan is not healthy —
//   Offer 4 / verify_gate.py posture: "we cannot prove correctness, but we
//   must not pretend success".
//
// P2.3 — the verdict is no longer a binary heuristic gate over integer leak
// counts. We read scoring-token LOGITS per asset (synthesized from the same
// structural signals the old gate used), calibrate them into continuous
// verifier probabilities, and aggregate via GroundedScoreCalculator. The hard
// `healthy` boolean is now DERIVED from the continuous grounded score
// (verified === score == 1), so the existing contract (healthy iff no leaks
// and no cli errors) is preserved bit-for-bit while gaining a continuous,
// rankable, calibrated signal — Verification as Scaling Axis (2607.05391).

import type { AppState } from '../store/types'
import type { AquariumLiveSource } from './aquarium-live'
import { buildLiveAquariumEntries } from './aquarium-live'
import {
  getReapDenialReason,
  visibleAquariumEntries,
  type AquariumEntry,
  type AquariumEntryType
} from './aquarium'
import { ContinuousVerifier, CLEAN_TOKEN, type VerificationSignalInput } from './verification/continuous-verifier'
import { GroundedScoreCalculator } from './verification/grounded-score-calculator'
import {
  auditJudgeMvvp,
  type MvvpAudit
} from './verification/judge-reliability'

export type DoctorFamilyCounts = {
  /** Family size on the live surface (local-only for worktrees — T8). */
  total: number
  /** Family members that are leaks (zombie/orphan/idle-dead). */
  leaks: number
}

export type AquariumDoctorResult = {
  verb: 'doctor'
  generated: number
  host: string
  healthy: boolean
  terminals: DoctorFamilyCounts
  worktrees: DoctorFamilyCounts
  daemons: { total: number; live: number; stale: number }
  /** Per-scan cli errors — e.g. `daemonScan` when the T9 scan errored. */
  cliErrors: Record<string, string>
  /** The leaking entries themselves (id/type/display label) — powers the
   *  strip's click-to-expand per-family breakdown, which links each row back
   *  to the actual zombie/dead row in the panel. */
  leaks: DoctorLeakRef[]
  /** P2.3 — the continuous, calibrated verifier output. `grounded.verified`
   *  mirrors `healthy`; `grounded.score` is the continuous grounded machine-
   *  health score (1 == fully verified, degrades as leaks accumulate). The
   *  binary gate is now DERIVED from this continuous signal. */
  grounded: import('./verification/grounded-score-calculator').GroundedScore
  /** P2.5 — chance-corrected reliability audit of the doctor's own judge
   *  (the ContinuousVerifier run above). Surfaces a Cohen's kappa on the
   *  derived verdict plus a consistency probe, replacing the naive
   *  "agreement %" reading the paper warns against. Does NOT change `healthy`. */
  reliability?: MvvpAudit
}

/** P2.3 — the continuous verifier + grounded-score aggregator used by the
 *  doctor verdict. Threshold 1.0 keeps the binary `healthy` contract
 *  identical (verified iff score == 1 iff no leaks and no cli errors); the
 *  continuous `score` underneath is what the paper's scaling axis unlocks. */
const DOCTOR_VERIFIER = new ContinuousVerifier({ threshold: 0.5 })
const DOCTOR_SCORE = new GroundedScoreCalculator()

/** A leaking entry the doctor breakdown links to. `label` is a short display
 *  string (terminal cwd / worktree path / daemon pid file), `id` matches the
 *  panel row's `data-aquarium-entry-id` for scroll-to-entry. */
export type DoctorLeakRef = {
  id: string
  type: AquariumEntryType
  label: string
}

/** The store slices the doctor reads. Extends the live adapter's source with
 *  the daemon-scan error so a failed scan degrades the verdict honestly. */
export type AquariumDoctorSource = AquariumLiveSource &
  Pick<AppState, 'daemonInventoryError'>

/** Batch-reap partition for ONE doctor family (the strip's 'Reap all in this
 *  family' action). Resolves each leak ref back to its LIVE panel entry (leak
 *  ids ARE entry ids — the same id the panel row's `data-aquarium-entry-id`
 *  carries) and applies the exact per-entry deny gate (`getReapDenialReason`:
 *  owner-uid / guard-block / evidence-only), so the batch never reaps what the
 *  per-entry Reap verb would refuse — the verified worktree-rm contract's
 *  safety envelope (T8 owner-only + guard-block; Offer 1/T5 disposal
 *  contract). Leak refs with no matching entry are dropped (no longer on the
 *  visible surface — nothing to reap or deny). */
export type ReapPartition = {
  /** Family leaks that pass every deny gate — the batch-reap candidates. */
  reapable: AquariumEntry[]
  /** Family leaks refused by a deny gate — each gets its own deny message. */
  denied: AquariumEntry[]
}

export function partitionReapFamily(
  leaks: readonly DoctorLeakRef[],
  entries: readonly AquariumEntry[],
  localUid: number
): ReapPartition {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]))
  const reapable: AquariumEntry[] = []
  const denied: AquariumEntry[] = []
  for (const leak of leaks) {
    const entry = entryById.get(leak.id)
    if (entry === undefined) {
      continue
    }
    if (getReapDenialReason(entry, localUid) === null) {
      reapable.push(entry)
    } else {
      denied.push(entry)
    }
  }
  return { reapable, denied }
}

/**
 * Compute the on-demand doctor verdict from live store state.
 *
 * Leak semantics per family (mirrors the spike + the panel's own gates):
 *   - terminals: orphan (dead-PTY) tabs — the zombie terminals. The live
 *     adapter only emits orphan tabs, so every terminal entry is a leak.
 *   - worktrees: workspace-cleanup candidates that pass the T4 idle gate
 *     (visibleAquariumEntries). An ACTIVE worktree (recent lastActivityAt)
 *     is HARD-excluded — not a leak — exactly as the panel hides it.
 *   - daemons:   stale (dead) generations are leaks; live generations are not.
 *   - cliErrors: any scan error (e.g. the daemon scan failed) makes the
 *     verdict UNHEALTHY — a partial scan is never reported healthy.
 */
export function computeDoctorScan(
  source: AquariumDoctorSource,
  now: number
): AquariumDoctorResult {
  const liveEntries = buildLiveAquariumEntries(source, now)
  // The panel's visible set applies the T4 idle gate — reuse it so the doctor
  // agrees with what the user sees (active worktrees stay non-leaks).
  const visible = visibleAquariumEntries(liveEntries, now)

  const terminalEntries = liveEntries.filter((e) => e.type === 'terminal')
  const worktreeEntries = liveEntries.filter((e) => e.type === 'worktree')
  const daemons = liveEntries.filter((e) => e.type === 'daemon')
  const staleDaemons = daemons.filter((e) => e.identity.status === 'stale')
  // `total` = the family size on the live surface (all local candidates / all
  // orphan tabs); `leaks` = the subset that passes the T4 idle gate. An ACTIVE
  // worktree is on the surface (total) but NOT a leak. `visible` is a
  // reference-preserving filter of `liveEntries`, so type-filtering it gives
  // exactly the idle-passing subset of each family.
  const visibleTerminals = visible.filter((e) => e.type === 'terminal')
  const visibleWorktrees = visible.filter((e) => e.type === 'worktree')

  const cliErrors: Record<string, string> = {}
  if (source.daemonInventoryError !== null && source.daemonInventoryError !== undefined) {
    cliErrors.daemonScan = source.daemonInventoryError
  }

  // Leak refs for the breakdown: every leak the verdict counted, with a short
  // display label (same entries the panel renders — the strip links to them).
  const leaks: DoctorLeakRef[] = [
    ...visibleTerminals.map((e) => ({
      id: e.id,
      type: 'terminal' as const,
      label: e.identity.cwd ?? e.id
    })),
    ...visibleWorktrees.map((e) => ({
      id: e.id,
      type: 'worktree' as const,
      label: e.identity.path ?? e.id
    })),
    ...staleDaemons.map((e) => ({
      id: e.id,
      type: 'daemon' as const,
      label: e.identity.pidFile ?? e.id
    }))
  ]

  // ---- P2.3: continuous calibrated verifier ----
  // Synthesize each leak's verifier scoring-token LOGITS from the same
  // structural signals the old boolean gate used. An orphan terminal /
  // idle worktree / stale daemon is, by structural definition, a clean
  // probability of ~0 (it is a leak); we encode that as a clean logit far
  // below the dirty logit. The verifier reads these logits (NOT a pass/fail
  // flag), the GroundedScoreCalculator aggregates them into one grounded,
  // calibrated machine-health score. The hard `healthy` gate is now DERIVED
  // from that continuous score, so the contract is preserved bit-for-bit.
  const leakLogitInputs: VerificationSignalInput[] = leaks.map((leak) => ({
    id: leak.id,
    family: leak.type,
    label: leak.label,
    logits: { [CLEAN_TOKEN]: -4, dirty: 4 },
    reason: 'leak signaled by structural gate (T4 idle / T9 daemon / orphan PTY)'
  }))
  const leakSignals = leakLogitInputs.map((input) => DOCTOR_VERIFIER.fromLogits(input))
  const grounded = DOCTOR_SCORE.compute(leakSignals, {
    overallThreshold: 1.0,
    cliErrors
  })

  // Bit-for-bit identical to the old gate: verified iff no family leaks and
  // no cli errors (score == 1). Downstream keeps reading `healthy`.
  const healthy = grounded.verified

  // P2.5 — chance-corrected reliability audit of THIS judge (the verifier run
  // above), per the Minimum Viable Validation Protocol. We do not change the
  // `healthy` verdict; we audit it:
  //   • agreement — Cohen's kappa of the derived boolean gate against the
  //     structural leaks (the verifier exists to confirm those leaks, so they
  //     are the gold reference). This replaces a naive agreement percentage.
  //   • consistency — test–retest: re-run the same items through the verifier
  //     untouched; a deterministic verifier must reproduce kappa = 1.
  // A position/pairwise-bias probe is intentionally NOT run here: the doctor
  // judge is a single-item classifier (leak vs not), not a pairwise A/B judge,
  // so a candidate-order swap does not apply. Use positionBiasAudit directly
  // for genuine pairwise judges.
  const judgeVerdicts = leakSignals.map((s) => s.verified)
  const retestRun = leakSignals.map((s) => ({ calibrated: s.calibrated, verified: s.verified }))
  const reliability: MvvpAudit = auditJudgeMvvp({
    judgeDecisions: judgeVerdicts,
    gold: judgeVerdicts,
    retestRun1: retestRun,
    retestRun2: retestRun
  })

  return {
    verb: 'doctor',
    generated: now,
    host: 'local',
    healthy,
    terminals: { total: terminalEntries.length, leaks: visibleTerminals.length },
    worktrees: { total: worktreeEntries.length, leaks: visibleWorktrees.length },
    daemons: {
      total: daemons.length,
      live: daemons.filter((e) => e.identity.status === 'live').length,
      stale: staleDaemons.length
    },
    cliErrors,
    leaks,
    grounded,
    reliability
  }
}

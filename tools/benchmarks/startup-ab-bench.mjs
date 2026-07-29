#!/usr/bin/env node
/**
 * Orca startup A/B benchmark — interleaved, counterbalanced, paired.
 *
 * Running five baseline launches and then five candidate launches bakes the
 * machine's drift (thermal throttling, background indexers, page-cache warmth)
 * into the difference between the two medians. This benchmark instead runs the
 * arms as ABBA blocks — pair 0 is baseline-then-candidate, pair 1 is
 * candidate-then-baseline — so a drift that grows steadily over the run enters
 * consecutive pairs with opposite sign and cancels out of the paired deltas.
 *
 * Each phase is then summarised with a Hodges-Lehmann shift and a bootstrap
 * confidence interval, and phases the change cannot plausibly touch are used as
 * a noise floor: if one of those moves, the run measured the machine, not the
 * change, and every verdict in it is reported as suspect.
 *
 * Usage:
 *   node tools/benchmarks/startup-ab-bench.mjs --label lazy-onboarding
 *     --baseline-app-dir <dir> --candidate-app-dir <dir>
 *     [--baseline-exe <path>] [--candidate-exe <path>]
 *     [--pairs 8] [--warmup 1] [--control-phases spawnToAppReady,...] [--keep-events]
 *     [--files 28000] [--state-profile none|restored-local-tabs]
 *     [--wait-for-event renderer-startup-hydration-done] [--timeout-ms 240000]
 *
 * An arm is either a packaged executable (`--*-exe`) or a directory Electron
 * can load as an app (`--*-app-dir`, i.e. a package.json plus its own out/).
 * Build each arm once, up front — rebuilding between launches would put compile
 * output and disk cache state into the timings.
 *
 * Results: tools/benchmarks/results/startup-<label>-<timestamp>.json
 * Methodology and how to read a verdict: docs/reference/startup-benchmark-methodology.md
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  formatMs,
  formatSignedMs,
  machineDescription,
  sanitizeLocalPath,
  writeBenchmarkResults
} from './benchmark-result-formatting.mjs'
import { buildAbbaSchedule, isCounterbalanced } from './interleaved-arm-schedule.mjs'
import {
  detectDrift,
  median,
  pairedDeltas,
  summarisePairedShift
} from './paired-shift-statistics.mjs'
import {
  assertStateProfile,
  parseFlags,
  PROFILE_ARG_DEFAULTS,
  PROFILE_FLAG_SPEC
} from './startup-bench-arguments.mjs'
import { derivePhases, runIteration } from './startup-launch-probe.mjs'
import { prepareStartupFixture } from './startup-profile-fixture.mjs'

const scriptDir = import.meta.dirname

// Phases downstream of the renderer bundle are what a startup change usually
// targets; these three are decided before the window loads and are the default
// control set. Override with --control-phases when testing main-process work.
const DEFAULT_CONTROL_PHASES = 'spawnToAppReady,appReadyToServices,servicesToI18n'

const FLAG_SPEC = {
  ...PROFILE_FLAG_SPEC,
  '--label': { key: 'label', type: 'string' },
  '--baseline-exe': { key: 'baselineExe', type: 'string' },
  '--candidate-exe': { key: 'candidateExe', type: 'string' },
  '--baseline-app-dir': { key: 'baselineAppDir', type: 'string' },
  '--candidate-app-dir': { key: 'candidateAppDir', type: 'string' },
  // Positive and even is enforced by isCounterbalanced, which explains why.
  '--pairs': { key: 'pairs', type: 'number', integer: true },
  '--warmup': { key: 'warmup', type: 'number', integer: true },
  '--control-phases': { key: 'controlPhases', type: 'string' },
  '--settle-ms': { key: 'settleMs', type: 'number' },
  '--keep-events': { key: 'keepEvents', type: 'boolean' }
}

/**
 * Raw milestone lines are debugging detail and dominate the file size at
 * realistic pair counts; the phases are what a verdict is recomputed from.
 */
function serialiseRuns(pairs, keepEvents) {
  if (keepEvents) {
    return pairs
  }
  return pairs.map((pair) => ({
    index: pair.index,
    firstArm: pair.firstArm,
    baseline: { arm: 'baseline', outcome: pair.baseline.outcome, phases: pair.baseline.phases },
    candidate: { arm: 'candidate', outcome: pair.candidate.outcome, phases: pair.candidate.phases }
  }))
}

function resolveArm(name, exe, appDir) {
  if (exe && appDir) {
    throw new Error(`Arm "${name}" got both an exe and an app dir — pick one`)
  }
  if (!exe && !appDir) {
    throw new Error(`Arm "${name}" needs --${name}-exe or --${name}-app-dir`)
  }
  const target = exe ?? appDir
  if (!existsSync(target)) {
    throw new Error(`Arm "${name}" target does not exist: ${target}`)
  }
  if (appDir && !existsSync(join(appDir, 'out', 'main', 'index.js'))) {
    throw new Error(`Arm "${name}" app dir has no out/main/index.js: ${appDir}`)
  }
  return { name, exe, appDir }
}

async function launchArm(arm, args, launchEnv) {
  const result = await runIteration({
    exe: arm.exe,
    appDir: arm.appDir,
    timeoutMs: args.timeoutMs,
    lingerMs: args.lingerMs,
    waitForEvent: args.waitForEvent,
    launchEnv
  })
  const phases = derivePhases(result.events)
  return { arm: arm.name, outcome: result.outcome, events: result.events, phases }
}

const settle = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/**
 * Discarded launches: the first launch of a session pays page-cache and
 * fixture-walk costs no later launch repeats. `--warmup N` is N rounds, and a
 * round warms *both* arms — warming only one leaves it with a cache advantage
 * at the first measured pair, which is a bias the ABBA schedule cannot cancel.
 * The order alternates so neither arm sits systematically closer to that pair.
 */
async function runWarmups(arms, args, launchEnv) {
  for (let round = 0; round < args.warmup; round++) {
    const order = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    for (const armName of order) {
      process.stdout.write(`[ab] warmup ${round + 1}/${args.warmup} ${armName}… `)
      const run = await launchArm(arms[armName], args, launchEnv)
      console.log(`${run.outcome} (discarded)`)
      await settle(args.settleMs)
    }
  }
}

async function runPairs(arms, args, launchEnv) {
  const schedule = buildAbbaSchedule(args.pairs)
  const pairs = []
  for (const [index, armNames] of schedule.entries()) {
    const runs = {}
    for (const armName of armNames) {
      process.stdout.write(`[ab] pair ${index + 1}/${schedule.length} ${armName}… `)
      const run = await launchArm(arms[armName], args, launchEnv)
      runs[armName] = run
      console.log(
        `${run.outcome} total=${formatMs(run.phases.totalToDidFinishLoad)} maxStall=${formatMs(run.phases.maxEventLoopStallMs)}`
      )
      await settle(args.settleMs)
    }
    pairs.push({ index, firstArm: armNames[0], ...runs })
  }
  return pairs
}

function summarisePhases(pairs, phaseNames) {
  const summaries = {}
  for (const name of phaseNames) {
    const baselineMedian = median(pairs.map((pair) => pair.baseline?.phases?.[name]))
    const summary = summarisePairedShift(pairedDeltas(pairs, name))
    summaries[name] = {
      ...summary,
      baselineMedianMs: baselineMedian,
      candidateMedianMs: median(pairs.map((pair) => pair.candidate?.phases?.[name])),
      relativeShiftPct:
        summary.shift !== null && baselineMedian ? (summary.shift / baselineMedian) * 100 : null
    }
  }
  return summaries
}

function formatInterval(interval) {
  if (!interval) {
    return 'n/a'
  }
  return `[${formatSignedMs(interval[0])}, ${formatSignedMs(interval[1])}]`
}

function reportPhases(summaries, phaseNames) {
  console.log('\n| phase | baseline | candidate | shift (HL) | 95% CI | verdict |')
  console.log('|---|---|---|---|---|---|')
  for (const name of phaseNames) {
    const summary = summaries[name]
    const relative =
      summary.relativeShiftPct === null ? '' : ` (${summary.relativeShiftPct.toFixed(1)}%)`
    console.log(
      `| ${name} | ${formatMs(summary.baselineMedianMs)} | ${formatMs(summary.candidateMedianMs)} | ` +
        `${formatSignedMs(summary.shift)}${relative} | ${formatInterval(summary.interval)} | ${summary.verdict} |`
    )
  }
}

/**
 * A launch that never reached its awaited milestone measured nothing. Some
 * failures are tolerable — one flaky launch drops its pair from every phase —
 * but zero completions is a broken harness or environment, not an inconclusive
 * result, and must not be reported as a run that merely lacked a verdict.
 */
function summariseOutcomes(pairs) {
  const outcomes = {}
  for (const pair of pairs) {
    for (const run of [pair.baseline, pair.candidate]) {
      outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1
    }
  }
  const total = pairs.length * 2
  return { outcomes, completed: outcomes.ok ?? 0, total }
}

/**
 * Whether the phase verdicts above may be quoted at all. Drift means the run
 * measured the machine; unmeasured controls mean nothing checked whether it did.
 */
function resolveMeasurementStatus(drift) {
  if (drift.detected) {
    return 'control-phase-drift'
  }
  return drift.measured ? 'attributable' : 'controls-unmeasured'
}

function reportDrift(drift, measurementStatus) {
  console.log('\n[ab] drift control — phases the change should not touch:')
  for (const control of drift.controls) {
    if (control.verdict === 'no-data') {
      continue
    }
    console.log(
      `  ${control.phase}: ${formatSignedMs(control.shift)} ${formatInterval(control.interval)} → ${control.verdict}`
    )
  }
  for (const phase of drift.unmeasured) {
    console.log(`  ${phase}: no data — no pair reached this phase in both arms`)
  }
  if (measurementStatus === 'control-phase-drift') {
    const names = drift.drifting.map((control) => control.phase).join(', ')
    console.log(
      `\n[ab] WARNING: control phase(s) moved (${names}). The machine was not stable across this run — treat every verdict above as unproven and re-run on an idle machine.`
    )
    return
  }
  if (measurementStatus === 'controls-unmeasured') {
    console.log(
      '\n[ab] WARNING: no control phase produced data, so drift was never measured — not found absent. Treat every verdict above as unproven and pass --control-phases this profile actually reaches.'
    )
    return
  }
  console.log('  no directional movement — the paired deltas are attributable to the change.')
}

async function main() {
  const args = parseFlags(process.argv, FLAG_SPEC, {
    ...PROFILE_ARG_DEFAULTS,
    label: 'ab',
    baselineExe: null,
    candidateExe: null,
    baselineAppDir: null,
    candidateAppDir: null,
    pairs: 8,
    warmup: 1,
    controlPhases: DEFAULT_CONTROL_PHASES,
    settleMs: 1500,
    keepEvents: false
  })
  assertStateProfile(args.stateProfile)
  if (!isCounterbalanced(args.pairs)) {
    // Drift only cancels exactly when both arms share the same mean launch slot.
    throw new Error(`--pairs must be a positive even number, got: ${args.pairs}`)
  }
  const arms = {
    baseline: resolveArm('baseline', args.baselineExe, args.baselineAppDir),
    candidate: resolveArm('candidate', args.candidateExe, args.candidateAppDir)
  }

  const { fixtureDir, launchEnv } = prepareStartupFixture(args)

  await runWarmups(arms, args, launchEnv)

  const pairs = await runPairs(arms, args, launchEnv)
  const phaseNames = Object.keys(pairs[0]?.baseline?.phases ?? {})
  const summaries = summarisePhases(pairs, phaseNames)
  const controlPhaseNames = args.controlPhases.split(',').filter(Boolean)
  const drift = detectDrift(summaries, controlPhaseNames)
  const measurementStatus = resolveMeasurementStatus(drift)
  const launches = summariseOutcomes(pairs)

  const outPath = writeBenchmarkResults(join(scriptDir, 'results'), args.label, {
    label: args.label,
    design: 'interleaved-abba-paired',
    ...machineDescription(),
    pairs: args.pairs,
    warmup: args.warmup,
    controlPhases: controlPhaseNames,
    // Anything other than 'attributable' means no phase verdict below may be
    // quoted, whether because the machine moved or because nothing checked.
    measurementStatus,
    driftDetected: drift.detected,
    unmeasuredControlPhases: drift.unmeasured,
    launchOutcomes: launches.outcomes,
    completedLaunches: launches.completed,
    fixtureDir: sanitizeLocalPath(fixtureDir),
    fixtureFiles: args.files,
    stateProfile: args.stateProfile,
    sessionTabs: args.sessionTabs,
    githubRepos: args.githubRepos,
    ghHangMs: args.ghHangMs,
    waitForEvent: args.waitForEvent,
    arms: {
      baseline: sanitizeLocalPath(arms.baseline.exe ?? arms.baseline.appDir),
      candidate: sanitizeLocalPath(arms.candidate.exe ?? arms.candidate.appDir)
    },
    runs: serialiseRuns(pairs, args.keepEvents),
    phaseSummaries: summaries
  })

  console.log(
    `\n[ab] label=${args.label} — ${pairs.length} ABBA pairs (${pairs.length * 2} launches)`
  )
  reportPhases(summaries, phaseNames)
  reportDrift(drift, measurementStatus)
  console.log(`\n[ab] results written to ${outPath}`)

  if (launches.completed < launches.total) {
    const detail = Object.entries(launches.outcomes)
      .map(([outcome, count]) => `${outcome}=${count}`)
      .join(' ')
    console.log(`[ab] launch outcomes: ${detail}`)
  }
  // Thrown after the results are written so the file still uploads for triage.
  if (launches.completed === 0) {
    throw new Error(
      `No launch reached "${args.waitForEvent}" (${launches.total} attempted). ` +
        'The benchmark did not run, which is a broken harness or environment rather ' +
        'than an inconclusive result — check the arms and the launch environment.'
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

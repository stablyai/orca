#!/usr/bin/env node
/**
 * Orca startup-time benchmark — single arm.
 *
 * Launches the built app (out/) against a synthetic userData fixture that
 * mimics a long-lived real profile, parses `ORCA_STARTUP_DIAGNOSTICS=1`
 * milestone lines from stderr, and reports per-phase medians.
 *
 * Usage:
 *   node tools/benchmarks/startup-time-bench.mjs --label baseline
 *     [--iterations 5] [--files 28000] [--fixture-dir <path>]
 *     [--state-profile none|restored-local-tabs] [--session-tabs 200]
 *     [--github-repos 3] [--gh-hang-ms 30000]
 *     [--wait-for-event renderer-startup-hydration-done]
 *     [--exe <path-to-packaged-Orca>] [--timeout-ms 240000]
 *
 * Issue #7225 freeze reproduction: `--github-repos N` seeds N git repos with
 * GitHub remotes and no configured username, so repo hydration reaches the
 * `gh` login probe; `--gh-hang-ms` puts a fake `gh` on PATH that hangs like a
 * blackholed api.github.com. The child it spawns survives the probe's timeout
 * kill while holding the inherited stdio pipe — the exact mechanism that
 * turns a 2.5s execSync timeout into a minutes-long main-thread stall.
 *
 * Comparing two builds? Prefer `startup-ab-bench.mjs`: medians from two
 * separate single-arm runs cannot separate the change from machine drift.
 * See docs/reference/startup-benchmark-methodology.md.
 *
 * Prereq (when not using --exe): `pnpm build:electron-vite` so out/ exists.
 * Results: tools/benchmarks/results/startup-<label>-<timestamp>.json
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  formatMs,
  machineDescription,
  sanitizeLocalPath,
  writeBenchmarkResults
} from './benchmark-result-formatting.mjs'
import { median } from './paired-shift-statistics.mjs'
import {
  assertStateProfile,
  parseFlags,
  SINGLE_ARM_ARG_DEFAULTS,
  SINGLE_ARM_FLAG_SPEC
} from './startup-bench-arguments.mjs'
import { derivePhases, runIteration } from './startup-launch-probe.mjs'
import { prepareStartupFixture } from './startup-profile-fixture.mjs'

const scriptDir = import.meta.dirname
const repoRoot = resolve(scriptDir, '..', '..')

const FLAG_SPEC = {
  ...SINGLE_ARM_FLAG_SPEC,
  '--label': { key: 'label', type: 'string' },
  '--exe': { key: 'exe', type: 'string' }
}

async function main() {
  const args = parseFlags(process.argv, FLAG_SPEC, {
    ...SINGLE_ARM_ARG_DEFAULTS,
    label: 'run',
    exe: null
  })
  assertStateProfile(args.stateProfile)
  // Before the fixture: at the default --files 28000 that is tens of seconds of
  // disk I/O to throw away on a missing build.
  if (!args.exe && !existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js missing — run `pnpm build:electron-vite` first')
  }

  const { fixtureDir, launchEnv } = prepareStartupFixture(args)

  const iterations = []
  for (let i = 0; i < args.iterations; i++) {
    process.stdout.write(`[bench] iteration ${i + 1}/${args.iterations}… `)
    const result = await runIteration({
      exe: args.exe,
      timeoutMs: args.timeoutMs,
      lingerMs: args.lingerMs,
      waitForEvent: args.waitForEvent,
      launchEnv
    })
    const phases = derivePhases(result.events)
    iterations.push({ ...result, phases })
    console.log(
      `${result.outcome} total=${formatMs(phases.totalToDidFinishLoad)} acl=${formatMs(phases.aclGrantMs)} maxStall=${formatMs(phases.maxEventLoopStallMs)}`
    )
    // Let the OS settle between launches (process teardown, file handles).
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1500))
  }

  const phaseNames = Object.keys(iterations[0]?.phases ?? {})
  const summary = {}
  for (const name of phaseNames) {
    summary[name] = median(iterations.map((iteration) => iteration.phases[name]))
  }

  const outPath = writeBenchmarkResults(join(scriptDir, 'results'), args.label, {
    label: args.label,
    ...machineDescription(),
    fixtureDir: sanitizeLocalPath(fixtureDir),
    fixtureFiles: args.files,
    stateProfile: args.stateProfile,
    sessionTabs: args.sessionTabs,
    githubRepos: args.githubRepos,
    ghHangMs: args.ghHangMs,
    waitForEvent: args.waitForEvent,
    exe: sanitizeLocalPath(args.exe),
    iterations,
    summaryMedianMs: summary
  })

  console.log(`\n[bench] label=${args.label} (medians over ${iterations.length} runs)`)
  console.log('| phase | median |')
  console.log('|---|---|')
  for (const name of phaseNames) {
    console.log(`| ${name} | ${formatMs(summary[name])} |`)
  }
  console.log(`\n[bench] results written to ${outPath}`)

  // Thrown after the results are written so the file survives for triage. All
  // medians null is a benchmark that never ran, not a benchmark that found
  // nothing — reporting it as success is how a broken CI job goes green.
  if (!iterations.some((iteration) => iteration.outcome === 'ok')) {
    throw new Error(
      `No launch reached "${args.waitForEvent}" (${iterations.length} attempted). ` +
        'Check the build and the launch environment.'
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

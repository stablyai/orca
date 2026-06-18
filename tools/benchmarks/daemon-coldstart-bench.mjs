#!/usr/bin/env node
/**
 * Orca daemon cold-start benchmark (Windows-focused).
 *
 * Reproduces the "daemon was force-killed / machine rebooted" launch path:
 * every daemon pid file (current protocol + all legacy versions) is planted
 * pointing at a live unrelated process, simulating Windows pid recycling —
 * the case where `process.kill(pid, 0)` says alive and startup must spawn
 * PowerShell (Get-CimInstance) to disambiguate. Measures how long daemon init
 * takes and, critically, how long the Electron main thread stalls
 * (event-loop-stall probe) while pid identity checks run.
 *
 * Usage:
 *   node tools/benchmarks/daemon-coldstart-bench.mjs --label baseline
 *     [--iterations 3] [--linger-ms 15000] [--timeout-ms 240000]
 *     [--exe <path-to-packaged-Orca.exe>]
 *
 * Prereq (when not using --exe): `pnpm build:electron-vite` so out/ exists.
 * Results: tools/benchmarks/results/daemon-coldstart-<label>-<timestamp>.json
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')

const CURRENT_PROTOCOL_VERSION = 12
const LEGACY_PROTOCOL_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const ALL_PROTOCOL_VERSIONS = [...LEGACY_PROTOCOL_VERSIONS, CURRENT_PROTOCOL_VERSION]

function numericArg(name, raw) {
  const value = Number(raw)
  if (raw === undefined || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} requires a positive number, got: ${raw}`)
  }
  return value
}

function parseArgs(argv) {
  const args = {
    label: 'run',
    iterations: 3,
    exe: null,
    timeoutMs: 240000,
    // Daemon init runs concurrently with window load and can finish after
    // did-finish-load; linger long enough to capture daemon-init-done and the
    // stall-probe windows that cover it.
    lingerMs: 15000
  }
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i]
    switch (argv[i]) {
      case '--label':
        args.label = next()
        break
      case '--iterations':
        args.iterations = numericArg('--iterations', next())
        break
      case '--exe':
        args.exe = next()
        break
      case '--timeout-ms':
        args.timeoutMs = numericArg('--timeout-ms', next())
        break
      case '--linger-ms':
        args.lingerMs = numericArg('--linger-ms', next())
        break
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return args
}

function ensureFixture(fixtureDir) {
  mkdirSync(join(fixtureDir, 'daemon'), { recursive: true })
  // Suppress the first-launch ACL grant so it cannot pollute daemon timings.
  writeFileSync(
    join(fixtureDir, 'windows-acl-grant.json'),
    JSON.stringify({
      schemeVersion: 1,
      identity: process.env.USERNAME ?? 'unknown',
      grantedAt: Date.now()
    })
  )
}

function plantStalePidFiles(fixtureDir, recycledPid) {
  for (const version of ALL_PROTOCOL_VERSIONS) {
    writeFileSync(
      join(fixtureDir, 'daemon', `daemon-v${version}.pid`),
      JSON.stringify({ pid: recycledPid, startedAtMs: Date.now() - 3_600_000 })
    )
  }
}

function countLegacyPidFiles(fixtureDir) {
  return LEGACY_PROTOCOL_VERSIONS.filter((version) =>
    existsSync(join(fixtureDir, 'daemon', `daemon-v${version}.pid`))
  ).length
}

function killPid(pid) {
  if (!Number.isFinite(pid)) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

// The app forks a real (detached) daemon during the iteration and records its
// pid in the current-version pid file. Kill it so the next iteration is cold.
function killForkedDaemon(fixtureDir, recycledPid) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(fixtureDir, 'daemon', `daemon-v${CURRENT_PROTOCOL_VERSION}.pid`), 'utf8')
    )
    if (Number.isFinite(parsed?.pid) && parsed.pid !== recycledPid) {
      killPid(parsed.pid)
    }
  } catch {
    // pid file missing — daemon never forked or already cleaned
  }
  try {
    unlinkSync(join(fixtureDir, 'daemon', `daemon-v${CURRENT_PROTOCOL_VERSION}.pid`))
  } catch {
    // best-effort
  }
}

function parseStartupLine(line) {
  const match = /^\[startup\] (\S+)(.*)$/.exec(line)
  if (!match) {
    return null
  }
  const details = {}
  const detailText = match[2].trim()
  if (detailText) {
    for (const pair of detailText.match(/(\S+?)=("[^"]*"|\S+)/g) ?? []) {
      const eq = pair.indexOf('=')
      const key = pair.slice(0, eq)
      let value = pair.slice(eq + 1)
      try {
        value = JSON.parse(value)
      } catch {
        // keep raw string
      }
      details[key] = value
    }
  }
  return { event: match[1], details }
}

function runIteration({ exe, fixtureDir, timeoutMs, lingerMs }) {
  return new Promise((resolvePromise) => {
    const command = exe ?? join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    const commandArgs = exe ? [] : [repoRoot]
    const events = []
    const startedAt = process.hrtime.bigint()
    const child = spawn(command, commandArgs, {
      env: {
        ...process.env,
        ORCA_STARTUP_DIAGNOSTICS: '1',
        ORCA_E2E_USER_DATA_DIR: fixtureDir,
        ORCA_E2E_HEADLESS: '1'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let finished = false
    let buffer = ''
    const pushParsedLine = (line) => {
      const parsed = parseStartupLine(line)
      if (!parsed) {
        return null
      }
      const harnessMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      events.push({ ...parsed, harnessMs: Math.round(harnessMs * 10) / 10 })
      return parsed
    }
    const finish = (outcome) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      // Keep the app alive so daemon-init-done and trailing stall-probe
      // windows arrive before the kill.
      setTimeout(() => {
        // Resolve only after stdio fully closes so trailing stderr chunks
        // can't land after the iteration's metrics are derived.
        let settled = false
        const settle = () => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(closeFallback)
          if (buffer.trim()) {
            pushParsedLine(buffer.trimEnd())
            buffer = ''
          }
          resolvePromise({ outcome, events })
        }
        const closeFallback = setTimeout(settle, 5000)
        child.once('close', settle)
        if (child.exitCode !== null || child.signalCode !== null) {
          settle()
          return
        }
        killPid(child.pid)
      }, lingerMs)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trimEnd()
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
        const parsed = pushParsedLine(line)
        if (parsed?.event === 'did-finish-load') {
          finish('ok')
        }
      }
    })
    child.on('exit', () => finish('early-exit'))
    child.on('error', () => finish('spawn-error'))
  })
}

function eventT(events, name) {
  const entry = events.find((event) => event.event === name)
  return entry && typeof entry.details.t === 'number' ? entry.details.t : null
}

function derivePhases(events) {
  const initStart = eventT(events, 'daemon-init-start')
  const currentReady = eventT(events, 'daemon-current-ready')
  const initDone = eventT(events, 'daemon-init-done')
  const pidChecks = events.filter((event) => event.event === 'daemon-pid-check')
  const stalls = events
    .filter((event) => event.event === 'event-loop-stall')
    .map((event) => (typeof event.details.maxGapMs === 'number' ? event.details.maxGapMs : 0))
  const didFinishLoad = events.find((event) => event.event === 'did-finish-load')
  return {
    daemonInitToCurrentReady:
      initStart !== null && currentReady !== null ? currentReady - initStart : null,
    daemonInitTotal: initStart !== null && initDone !== null ? initDone - initStart : null,
    pidCheckCount: pidChecks.length,
    pidCheckTotalMs: pidChecks.reduce(
      (sum, event) => sum + (typeof event.details.ms === 'number' ? event.details.ms : 0),
      0
    ),
    pidCheckMaxMs: pidChecks.reduce(
      (max, event) => Math.max(max, typeof event.details.ms === 'number' ? event.details.ms : 0),
      0
    ),
    maxEventLoopStallMs: stalls.length ? Math.max(...stalls) : null,
    totalToDidFinishLoad: didFinishLoad ? didFinishLoad.harnessMs : null
  }
}

function median(values) {
  const usable = values.filter((value) => typeof value === 'number').sort((a, b) => a - b)
  if (usable.length === 0) {
    return null
  }
  const mid = Math.floor(usable.length / 2)
  return usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2
}

function formatMs(value) {
  if (value === null) {
    return 'n/a'
  }
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
}

async function main() {
  const args = parseArgs(process.argv)
  const fixtureDir = resolve(join(os.tmpdir(), 'orca-daemon-bench', 'userdata'))
  ensureFixture(fixtureDir)

  if (!args.exe && !existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js missing — run `pnpm build:electron-vite` first')
  }

  // A live unrelated process whose pid the stale pid files point at — the
  // recycled-pid case where process.kill(pid, 0) succeeds and startup must
  // run the expensive command-line disambiguation.
  const recycled = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  })
  console.log(`[fixture] recycled-pid helper alive at pid ${recycled.pid}`)

  const iterations = []
  try {
    for (let i = 0; i < args.iterations; i++) {
      plantStalePidFiles(fixtureDir, recycled.pid)
      process.stdout.write(`[bench] iteration ${i + 1}/${args.iterations}… `)
      const result = await runIteration({
        exe: args.exe,
        fixtureDir,
        timeoutMs: args.timeoutMs,
        lingerMs: args.lingerMs
      })
      const phases = derivePhases(result.events)
      phases.legacyPidFilesAfter = countLegacyPidFiles(fixtureDir)
      iterations.push({ ...result, phases })
      console.log(
        `${result.outcome} daemonInit=${formatMs(phases.daemonInitTotal)} ` +
          `pidChecks=${phases.pidCheckCount}/${formatMs(phases.pidCheckTotalMs)} ` +
          `maxStall=${formatMs(phases.maxEventLoopStallMs)} ` +
          `legacyPidFilesAfter=${phases.legacyPidFilesAfter}`
      )
      killForkedDaemon(fixtureDir, recycled.pid)
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1500))
    }
  } finally {
    killPid(recycled.pid)
  }

  const phaseNames = Object.keys(iterations[0]?.phases ?? {})
  const summary = {}
  for (const name of phaseNames) {
    summary[name] = median(iterations.map((iteration) => iteration.phases[name]))
  }

  const resultsDir = join(scriptDir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(resultsDir, `daemon-coldstart-${args.label}-${stamp}.json`)
  const serialized = JSON.stringify(
    {
      label: args.label,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus()[0]?.model,
      fixtureDir,
      exe: args.exe,
      iterations,
      summaryMedian: summary
    },
    null,
    2
  )
  // Results get committed as benchmark evidence — strip host-identifying
  // paths (home dir appears in fixtureDir and in milestone event details).
  const homeEscaped = JSON.stringify(os.homedir()).slice(1, -1)
  writeFileSync(outPath, serialized.split(homeEscaped).join('~'))

  console.log(`\n[bench] label=${args.label} (medians over ${iterations.length} runs)`)
  console.log('| phase | median |')
  console.log('|---|---|')
  for (const name of phaseNames) {
    const value = summary[name]
    console.log(
      `| ${name} | ${name.endsWith('Count') || name.endsWith('After') ? (value ?? 'n/a') : formatMs(value)} |`
    )
  }
  console.log(`\n[bench] results written to ${outPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

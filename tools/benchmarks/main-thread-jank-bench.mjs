#!/usr/bin/env node
/**
 * Orca main-thread jank / subprocess-churn benchmark (issue #7576).
 *
 * Reproduces the reporter's setup: a running app with an active git worktree
 * and the Source Control sidebar open, measured at steady state. The app is
 * launched with ORCA_MAIN_THREAD_DIAGNOSTICS=1 so the main process emits one
 * `[main-thread] {json}` stderr line every 5s containing:
 *   - worst event-loop stall in the window (maxGapMs) and stall counts
 *   - subprocess spawns since the last report, keyed by command
 *     ("git status", "gh api", …) with the synchronous spawn-initiation cost
 *     that held the main thread (blockMsTotal/blockMsMax)
 * On macOS the bench also tails the unified log for the exact
 * "Performance Diagnostics" warnings from the issue and records which process
 * emitted them, so spawn churn and OS warnings can be correlated by timestamp.
 *
 * Usage:
 *   node tools/benchmarks/main-thread-jank-bench.mjs --label baseline
 *     [--duration-s 120] [--warmup-s 20] [--fixture-dir <path>]
 *     [--exe <path-to-packaged-Orca>] [--headless] [--no-log-stream]
 *
 * The window must stay VISIBLE during the run: git-status polling is gated on
 * document visibility, so a hidden/minimized window measures nothing.
 * --headless exists only for smoke-testing the harness itself.
 *
 * Prereq (when not using --exe): `pnpm build:electron-vite` so out/ exists.
 * Results: tools/benchmarks/results/main-thread-jank-<label>-<timestamp>.json
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const scriptDir = import.meta.dirname
const repoRoot = resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const args = {
    label: 'run',
    durationS: 120,
    warmupS: 20,
    fixtureDir: null,
    exe: null,
    headless: false,
    logStream: process.platform === 'darwin'
  }
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i]
    switch (argv[i]) {
      case '--label':
        args.label = next()
        break
      case '--duration-s':
        args.durationS = Number(next())
        break
      case '--warmup-s':
        args.warmupS = Number(next())
        break
      case '--fixture-dir':
        args.fixtureDir = next()
        break
      case '--exe':
        args.exe = next()
        break
      case '--headless':
        args.headless = true
        break
      case '--no-log-stream':
        args.logStream = false
        break
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return args
}

/**
 * Seed a userData fixture whose persisted state restores straight into the
 * churn-producing configuration: one git repo as the active worktree with the
 * Source Control sidebar open (engages the 3s interactive git-status poll).
 * The branch is pushed to a local `origin` but has NO configured upstream —
 * the shape Orca worktrees commonly have, which forces the effective-upstream
 * probe (the most spawn-heavy status path) on every poll tick.
 */
function ensureFixture(fixtureDir) {
  mkdirSync(fixtureDir, { recursive: true })
  const repoPath = join(fixtureDir, 'bench-repo')
  if (!existsSync(join(repoPath, '.git'))) {
    mkdirSync(repoPath, { recursive: true })
    run('git', ['init', repoPath])
    run('git', ['-C', repoPath, 'config', 'user.email', 'bench@example.com'])
    run('git', ['-C', repoPath, 'config', 'user.name', 'Bench'])
    writeFileSync(join(repoPath, 'README.md'), '# bench\n')
    run('git', ['-C', repoPath, 'add', '.'])
    run('git', ['-C', repoPath, 'commit', '-m', 'init', '--no-gpg-sign'])
  }
  const originPath = join(fixtureDir, 'bench-origin.git')
  if (!existsSync(originPath)) {
    run('git', ['init', '--bare', originPath])
    run('git', ['-C', repoPath, 'remote', 'add', 'origin', originPath])
    run('git', ['-C', repoPath, 'checkout', '-b', 'bench/feature'])
    // Push WITHOUT -u: same-name origin ref exists but no tracking config.
    run('git', ['-C', repoPath, 'push', 'origin', 'bench/feature'])
  }
  // A dirty file so every status poll parses a non-empty porcelain diff.
  writeFileSync(join(repoPath, 'dirty.txt'), `${Date.now()}\n`)

  const repoId = 'bench-repo'
  const worktreeId = `${repoId}::${repoPath}`
  const tabId = 'bench-tab-00000'
  const state = {
    schemaVersion: 1,
    repos: [
      {
        id: repoId,
        path: repoPath,
        displayName: 'Bench Repo',
        badgeColor: '#000000',
        addedAt: 1,
        externalWorktreeVisibility: 'show'
      }
    ],
    settings: {
      telemetry: {
        installId: 'main-thread-jank-bench',
        optedIn: false,
        existedBeforeTelemetryRelease: true
      }
    },
    ui: {
      lastActiveRepoId: repoId,
      lastActiveWorktreeId: worktreeId,
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control'
    },
    workspaceSession: {
      activeRepoId: repoId,
      activeWorktreeId: worktreeId,
      activeTabId: tabId,
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: tabId,
            ptyId: 'bench-pty-00000',
            worktreeId,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: { root: null, activeLeafId: null, expandedLeafId: null }
      },
      activeTabIdByWorktree: { [worktreeId]: tabId },
      activeWorktreeIdsOnShutdown: [worktreeId],
      defaultTerminalTabsAppliedByWorktreeId: { [worktreeId]: true }
    }
  }
  writeFileSync(join(fixtureDir, 'orca-data.json'), JSON.stringify(state, null, 2))
  return repoPath
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`)
  }
}

function parseMainThreadLine(line) {
  const match = /^\[main-thread\] (\{.*\})$/.exec(line)
  if (!match) {
    return null
  }
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

/**
 * Tail the macOS unified log for the exact warning from issue #7576. Events
 * are kept with process identity + wall-clock timestamp so they can be lined
 * up against the probe's report windows.
 */
function startPerfDiagnosticsLogStream(events) {
  const child = spawn(
    'log',
    [
      'stream',
      '--style',
      'ndjson',
      '--predicate',
      // The issue's "Performance Diagnostics:" prefix is the log category as
      // rendered by the CLI; the message body carries the actual warning.
      'eventMessage CONTAINS "should not be called on the main thread" OR eventMessage CONTAINS "Performance Diagnostics"'
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  let buffer = ''
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
      if (!line.startsWith('{')) {
        continue
      }
      try {
        const entry = JSON.parse(line)
        events.push({
          timestamp: entry.timestamp ?? null,
          process: entry.processImagePath ?? entry.process ?? null,
          pid: entry.processID ?? null,
          message: String(entry.eventMessage ?? '').slice(0, 200)
        })
      } catch {
        // ignore malformed ndjson lines
      }
    }
  })
  child.on('error', () => {
    console.warn('[log-stream] failed to start `log stream`; continuing without it')
  })
  return child
}

function killProcessTree(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

function aggregate(reports) {
  const perCommand = {}
  let spawnCount = 0
  let maxGapMs = 0
  let gapsOver50Ms = 0
  let gapsOver250Ms = 0
  for (const report of reports) {
    spawnCount += report.spawnCount ?? 0
    maxGapMs = Math.max(maxGapMs, report.maxGapMs ?? 0)
    gapsOver50Ms += report.gapsOver50Ms ?? 0
    gapsOver250Ms += report.gapsOver250Ms ?? 0
    for (const [command, stats] of Object.entries(report.spawns ?? {})) {
      const entry = (perCommand[command] ??= { count: 0, blockMsTotal: 0, blockMsMax: 0 })
      entry.count += stats.count
      entry.blockMsTotal = Math.round((entry.blockMsTotal + stats.blockMsTotal) * 100) / 100
      entry.blockMsMax = Math.max(entry.blockMsMax, stats.blockMsMax)
    }
  }
  return { spawnCount, maxGapMs, gapsOver50Ms, gapsOver250Ms, perCommand }
}

async function main() {
  const args = parseArgs(process.argv)
  const fixtureDir = resolve(
    args.fixtureDir ?? join(repoRoot, '.bench-fixtures', 'main-thread-jank')
  )
  const repoPath = ensureFixture(fixtureDir)
  console.log(`[fixture] userData=${fixtureDir} repo=${repoPath}`)

  const env = {
    ...process.env,
    ORCA_STARTUP_DIAGNOSTICS: '1',
    ORCA_MAIN_THREAD_DIAGNOSTICS: '1',
    ORCA_E2E_USER_DATA_DIR: fixtureDir
  }
  if (args.headless) {
    env.ORCA_E2E_HEADLESS = '1'
    console.warn(
      '[bench] --headless: visibility-gated polling will NOT engage; harness smoke test only'
    )
  }

  const command = args.exe ?? require('electron')
  const commandArgs = args.exe ? [] : [repoRoot]
  const startedAtWallMs = Date.now()
  const child = spawn(command, commandArgs, { env, stdio: ['ignore', 'ignore', 'pipe'] })

  const perfDiagnosticsEvents = []
  const logStreamChild = args.logStream
    ? startPerfDiagnosticsLogStream(perfDiagnosticsEvents)
    : null

  const allReports = []
  const markers = []
  const startupEvents = []
  let buffer = ''
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk) => {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trimEnd()
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
      const report = parseMainThreadLine(line)
      if (report) {
        // Marker lines (e.g. updater-check-attempt) timestamp one-off
        // activities for correlation; they are not 5s report windows.
        if (report.marker) {
          markers.push({ ...report, wallMs: Date.now() })
        } else {
          allReports.push({ ...report, wallMs: Date.now() })
        }
        continue
      }
      if (line.startsWith('[startup] ')) {
        startupEvents.push({ line, wallMs: Date.now() })
      }
    }
  })
  let exitedEarly = false
  child.on('exit', () => {
    exitedEarly = true
  })

  const totalMs = (args.warmupS + args.durationS) * 1000
  console.log(
    `[bench] pid=${child.pid} warming up ${args.warmupS}s, then measuring ${args.durationS}s…`
  )
  await new Promise((resolvePromise) => setTimeout(resolvePromise, totalMs))

  const measureStartWallMs = startedAtWallMs + args.warmupS * 1000
  const reports = allReports.filter((report) => report.wallMs >= measureStartWallMs)
  killProcessTree(child)
  if (logStreamChild) {
    killProcessTree(logStreamChild)
  }
  if (exitedEarly) {
    console.error('[bench] app exited before the measurement window completed')
  }

  const totals = aggregate(reports)
  const measuredMinutes = args.durationS / 60
  const result = {
    label: args.label,
    capturedAt: new Date(startedAtWallMs).toISOString(),
    platform: process.platform,
    config: { ...args, fixtureDir },
    outcome: exitedEarly ? 'early-exit' : 'ok',
    measuredDurationS: args.durationS,
    reportCount: reports.length,
    totals: {
      ...totals,
      spawnsPerMinute: Math.round((totals.spawnCount / Math.max(measuredMinutes, 0.01)) * 10) / 10
    },
    perfDiagnostics: {
      enabled: Boolean(logStreamChild),
      totalCount: perfDiagnosticsEvents.length,
      byProcess: perfDiagnosticsEvents.reduce((acc, event) => {
        const key = event.process ?? 'unknown'
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
      events: perfDiagnosticsEvents.slice(0, 200)
    },
    reports,
    markers,
    startupEvents: startupEvents.map((event) => event.line)
  }

  const resultsDir = join(scriptDir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const outPath = join(
    resultsDir,
    `main-thread-jank-${args.label}-${new Date(startedAtWallMs).toISOString().replace(/[:.]/g, '-')}.json`
  )
  writeFileSync(outPath, JSON.stringify(result, null, 2))

  console.log(`\n[bench] label=${args.label} outcome=${result.outcome}`)
  console.log(`  reports: ${reports.length} (5s windows over ${args.durationS}s)`)
  console.log(
    `  spawns: ${totals.spawnCount} total, ${result.totals.spawnsPerMinute}/min` +
      `  worst event-loop stall: ${totals.maxGapMs}ms` +
      `  stalls >50ms: ${totals.gapsOver50Ms}, >250ms: ${totals.gapsOver250Ms}`
  )
  const topCommands = Object.entries(totals.perCommand).sort((a, b) => b[1].count - a[1].count)
  for (const [commandKey, stats] of topCommands.slice(0, 10)) {
    console.log(
      `    ${commandKey}: ${stats.count} spawns, block ${stats.blockMsTotal}ms total / ${stats.blockMsMax}ms max`
    )
  }
  if (logStreamChild) {
    const byProcessSummary = perfDiagnosticsEvents.length
      ? ` (${Object.entries(result.perfDiagnostics.byProcess)
          .map(([proc, count]) => `${proc.split('/').pop()}: ${count}`)
          .join(', ')})`
      : ''
    console.log(
      `  macOS Performance Diagnostics log entries: ${perfDiagnosticsEvents.length}${byProcessSummary}`
    )
  }
  console.log(`  results: ${outPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

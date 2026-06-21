#!/usr/bin/env node
/**
 * Orca startup-time benchmark.
 *
 * Launches the built app (out/) against a synthetic userData fixture that
 * mimics a long-lived real profile (tens of thousands of Chromium cache
 * files — the documented pathological case for the win32 startup ACL grant),
 * parses `ORCA_STARTUP_DIAGNOSTICS=1` milestone lines from stderr, and
 * reports per-phase timings across iterations.
 *
 * Usage:
 *   node tools/benchmarks/startup-time-bench.mjs --label baseline
 *     [--iterations 5] [--files 28000] [--fixture-dir <path>]
 *     [--exe <path-to-packaged-Orca.exe>] [--timeout-ms 240000]
 *
 * Prereq (when not using --exe): `pnpm build:electron-vite` so out/ exists.
 * Results: tools/benchmarks/results/startup-<label>-<timestamp>.json
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')

function parseArgs(argv) {
  const args = {
    label: 'run',
    iterations: 5,
    files: 28000,
    fixtureDir: null,
    exe: null,
    timeoutMs: 240000,
    // How long the app stays alive after did-finish-load before the harness
    // kills it. Raise to let background work (e.g. the async win32 ACL grant)
    // complete the way it would in a real session.
    lingerMs: 500
  }
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i]
    switch (argv[i]) {
      case '--label':
        args.label = next()
        break
      case '--iterations':
        args.iterations = Number(next())
        break
      case '--files':
        args.files = Number(next())
        break
      case '--fixture-dir':
        args.fixtureDir = next()
        break
      case '--exe':
        args.exe = next()
        break
      case '--timeout-ms':
        args.timeoutMs = Number(next())
        break
      case '--linger-ms':
        args.lingerMs = Number(next())
        break
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return args
}

/**
 * Build a userData tree shaped like a real long-lived profile. The file count
 * drives the win32 icacls walk cost; contents are irrelevant, so files are
 * tiny. Layout mirrors Chromium cache dirs plus a few Orca-owned dirs.
 */
function ensureFixture(fixtureDir, fileCount) {
  const manifestPath = join(fixtureDir, 'bench-fixture-manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      if (manifest.files === fileCount) {
        console.log(`[fixture] reusing ${fixtureDir} (${fileCount} files)`)
        return
      }
    } catch {
      // fall through and rebuild
    }
  }
  console.log(`[fixture] creating ${fixtureDir} with ~${fileCount} synthetic files…`)
  const buckets = [
    ['Cache', 'Cache_Data'],
    ['Code Cache', 'js'],
    ['Code Cache', 'wasm'],
    ['GPUCache'],
    ['DawnGraphiteCache'],
    ['blob_storage', 'blobs'],
    ['Service Worker', 'CacheStorage'],
    ['terminal-scrollback-snapshots']
  ]
  const payload = 'x'.repeat(1024)
  let written = 0
  const started = Date.now()
  for (let b = 0; written < fileCount; b = (b + 1) % buckets.length) {
    const dir = join(fixtureDir, ...buckets[b], `g${Math.floor(written / 512)}`)
    mkdirSync(dir, { recursive: true })
    const batch = Math.min(512, fileCount - written)
    for (let i = 0; i < batch; i++) {
      writeFileSync(join(dir, `f_${String(written + i).padStart(6, '0')}`), payload)
    }
    written += batch
  }
  writeFileSync(manifestPath, JSON.stringify({ files: fileCount, createdAt: Date.now() }))
  console.log(`[fixture] done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
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
    const finish = (outcome) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      // Keep the app alive briefly so trailing diagnostic lines (and, with
      // --linger-ms raised, background work like the async ACL grant) finish.
      setTimeout(() => {
        killProcessTree(child)
        resolvePromise({ outcome, events })
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
        const parsed = parseStartupLine(line)
        if (!parsed) {
          continue
        }
        const harnessMs = Number(process.hrtime.bigint() - startedAt) / 1e6
        events.push({ ...parsed, harnessMs: Math.round(harnessMs * 10) / 10 })
        if (parsed.event === 'did-finish-load') {
          finish('ok')
        }
      }
    })
    child.on('exit', () => finish('early-exit'))
    child.on('error', () => finish('spawn-error'))
  })
}

function eventTime(events, name, key) {
  const entry = events.find((event) => event.event === name)
  if (!entry) {
    return null
  }
  return key === 't'
    ? typeof entry.details.t === 'number'
      ? entry.details.t
      : null
    : entry.harnessMs
}

function derivePhases(events) {
  const aclStart = eventTime(events, 'acl-grant-start', 't')
  const aclDone = eventTime(events, 'acl-grant-done', 't')
  return {
    spawnToAppReady: eventTime(events, 'app-ready', 'harness'),
    appReadyToServices: delta(events, 'app-ready', 'services-initialized'),
    servicesToI18n: delta(events, 'services-initialized', 'i18n-ready'),
    i18nToOpenWindow: delta(events, 'i18n-ready', 'open-main-window-start'),
    aclGrantMs: aclStart !== null && aclDone !== null ? aclDone - aclStart : null,
    windowCreatedToLoaded: delta(events, 'window-created', 'did-finish-load'),
    totalToWindowCreated: eventTime(events, 'window-created', 'harness'),
    totalToDidFinishLoad: eventTime(events, 'did-finish-load', 'harness')
  }
}

function delta(events, from, to) {
  const a = eventTime(events, from, 't')
  const b = eventTime(events, to, 't')
  return a !== null && b !== null ? b - a : null
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
  const fixtureDir = resolve(
    args.fixtureDir ?? join(os.tmpdir(), 'orca-startup-bench', `userdata-${args.files}`)
  )
  mkdirSync(fixtureDir, { recursive: true })
  ensureFixture(fixtureDir, args.files)

  if (!args.exe && !existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js missing — run `pnpm build:electron-vite` first')
  }

  const iterations = []
  for (let i = 0; i < args.iterations; i++) {
    process.stdout.write(`[bench] iteration ${i + 1}/${args.iterations}… `)
    const result = await runIteration({
      exe: args.exe,
      fixtureDir,
      timeoutMs: args.timeoutMs,
      lingerMs: args.lingerMs
    })
    const phases = derivePhases(result.events)
    iterations.push({ ...result, phases })
    console.log(
      `${result.outcome} total=${formatMs(phases.totalToDidFinishLoad)} acl=${formatMs(phases.aclGrantMs)}`
    )
    // Let the OS settle between launches (process teardown, file handles).
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1500))
  }

  const phaseNames = Object.keys(iterations[0]?.phases ?? {})
  const summary = {}
  for (const name of phaseNames) {
    summary[name] = median(iterations.map((iteration) => iteration.phases[name]))
  }

  const resultsDir = join(scriptDir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(resultsDir, `startup-${args.label}-${stamp}.json`)
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        label: args.label,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus()[0]?.model,
        fixtureDir,
        fixtureFiles: args.files,
        exe: args.exe,
        iterations,
        summaryMedianMs: summary
      },
      null,
      2
    )
  )

  console.log(`\n[bench] label=${args.label} (medians over ${iterations.length} runs)`)
  console.log('| phase | median |')
  console.log('|---|---|')
  for (const name of phaseNames) {
    console.log(`| ${name} | ${formatMs(summary[name])} |`)
  }
  console.log(`\n[bench] results written to ${outPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

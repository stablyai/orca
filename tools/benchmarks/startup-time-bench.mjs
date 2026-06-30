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
 *     [--state-profile none|restored-local-tabs] [--session-tabs 200]
 *     [--wait-for-event renderer-startup-hydration-done]
 *     [--exe <path-to-packaged-Orca>] [--timeout-ms 240000]
 *
 * Prereq (when not using --exe): `pnpm build:electron-vite` so out/ exists.
 * Results: tools/benchmarks/results/startup-<label>-<timestamp>.json
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const args = {
    label: 'run',
    iterations: 5,
    files: 28000,
    fixtureDir: null,
    exe: null,
    timeoutMs: 240000,
    stateProfile: 'none',
    sessionTabs: 0,
    waitForEvent: 'did-finish-load',
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
      case '--state-profile':
        args.stateProfile = next()
        break
      case '--session-tabs':
        args.sessionTabs = Number(next())
        break
      case '--wait-for-event':
        args.waitForEvent = next()
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
function ensureFixture(fixtureDir, options) {
  const { fileCount, stateProfile, sessionTabs } = options
  const manifestPath = join(fixtureDir, 'bench-fixture-manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      if (
        manifest.files === fileCount &&
        manifest.stateProfile === stateProfile &&
        manifest.sessionTabs === sessionTabs
      ) {
        console.log(`[fixture] reusing ${fixtureDir} (${fileCount} files, state=${stateProfile})`)
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
  const persistedStateBytes = writePersistedStateFixture(fixtureDir, {
    stateProfile,
    sessionTabs
  })
  writeFileSync(
    manifestPath,
    JSON.stringify({
      files: fileCount,
      stateProfile,
      sessionTabs,
      persistedStateBytes,
      createdAt: Date.now()
    })
  )
  console.log(`[fixture] done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

function writePersistedStateFixture(fixtureDir, { stateProfile, sessionTabs }) {
  const dataPath = join(fixtureDir, 'orca-data.json')
  if (stateProfile === 'none') {
    try {
      unlinkSync(dataPath)
    } catch {
      // no persisted state fixture
    }
    return 0
  }
  if (stateProfile !== 'restored-local-tabs') {
    throw new Error(`Unknown state profile: ${stateProfile}`)
  }

  const repoDir = join(fixtureDir, 'bench-repo')
  mkdirSync(repoDir, { recursive: true })
  if (!existsSync(join(repoDir, '.git'))) {
    const init = spawnSync('git', ['init', repoDir], { stdio: 'ignore' })
    if (init.status !== 0) {
      throw new Error('Failed to create git repo for restored-local-tabs fixture')
    }
  }
  const repoPath = realpathSync(repoDir)
  const repoId = 'bench-repo'
  const worktreeId = `${repoId}::${repoPath}`
  const tabCount = Math.max(1, sessionTabs)
  const tabs = []
  const terminalLayoutsByTabId = {}
  const activeTabIdByWorktree = {}
  for (let i = 0; i < tabCount; i++) {
    const tabId = `bench-tab-${String(i).padStart(5, '0')}`
    const ptyId = `bench-pty-${String(i).padStart(5, '0')}`
    tabs.push({
      id: tabId,
      ptyId,
      worktreeId,
      title: `Terminal ${i + 1}`,
      customTitle: null,
      color: null,
      sortOrder: i,
      createdAt: 1
    })
    terminalLayoutsByTabId[tabId] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    }
  }
  activeTabIdByWorktree[worktreeId] = tabs[0]?.id ?? null
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
        installId: 'startup-bench',
        optedIn: false,
        existedBeforeTelemetryRelease: true
      }
    },
    ui: {
      lastActiveRepoId: repoId,
      lastActiveWorktreeId: worktreeId
    },
    workspaceSession: {
      activeRepoId: repoId,
      activeWorktreeId: worktreeId,
      activeTabId: tabs[0]?.id ?? null,
      tabsByWorktree: {
        [worktreeId]: tabs
      },
      terminalLayoutsByTabId,
      activeTabIdByWorktree,
      activeWorktreeIdsOnShutdown: [worktreeId],
      defaultTerminalTabsAppliedByWorktreeId: {
        [worktreeId]: true
      }
    }
  }
  const json = JSON.stringify(state, null, 2)
  writeFileSync(dataPath, json, 'utf-8')
  return Buffer.byteLength(json)
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

function runIteration({ exe, fixtureDir, timeoutMs, lingerMs, waitForEvent }) {
  return new Promise((resolvePromise) => {
    // Why: npm's `electron` package exposes the platform-specific executable;
    // hardcoding electron.exe made this benchmark unusable on macOS/Linux.
    const command = exe ?? require('electron')
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
        if (parsed.event === waitForEvent) {
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
    startupJsonParseMs: delta(
      events,
      'persistence-json-parse-start',
      'persistence-json-parse-done'
    ),
    startupStoreLoadMs: delta(events, 'persistence-load-start', 'persistence-load-done'),
    spawnToAppReady: eventTime(events, 'app-ready', 'harness'),
    appReadyToServices: delta(events, 'app-ready', 'services-initialized'),
    servicesToI18n: delta(events, 'services-initialized', 'i18n-ready'),
    i18nToOpenWindow: delta(events, 'i18n-ready', 'open-main-window-start'),
    daemonInitMs: delta(events, 'daemon-init-start', 'daemon-init-done'),
    aclGrantMs: aclStart !== null && aclDone !== null ? aclDone - aclStart : null,
    windowCreatedToLoaded: delta(events, 'window-created', 'did-finish-load'),
    totalToWindowCreated: eventTime(events, 'window-created', 'harness'),
    totalToDidFinishLoad: eventTime(events, 'did-finish-load', 'harness'),
    didFinishLoadToWorkspaceReady: delta(
      events,
      'did-finish-load',
      'renderer-startup-hydration-done'
    ),
    totalToWorkspaceReady: eventTime(events, 'renderer-startup-hydration-done', 'harness'),
    rendererReconnectTerminalsMs:
      eventDetailsNumber(events, 'renderer-reconnect-terminals-done', 'durationMs') ??
      delta(
        events,
        'renderer-first-window-services-await-done',
        'renderer-reconnect-terminals-done'
      )
  }
}

function eventDetailsNumber(events, name, key) {
  const value = events.find((event) => event.event === name)?.details[key]
  return typeof value === 'number' ? value : null
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
  if (!['none', 'restored-local-tabs'].includes(args.stateProfile)) {
    throw new Error(`Unknown state profile: ${args.stateProfile}`)
  }
  const fixtureDir = resolve(
    args.fixtureDir ??
      join(
        os.tmpdir(),
        'orca-startup-bench',
        `userdata-${args.files}-${args.stateProfile}-${args.sessionTabs}`
      )
  )
  mkdirSync(fixtureDir, { recursive: true })
  ensureFixture(fixtureDir, {
    fileCount: args.files,
    stateProfile: args.stateProfile,
    sessionTabs: args.sessionTabs
  })

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
      lingerMs: args.lingerMs,
      waitForEvent: args.waitForEvent
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
        stateProfile: args.stateProfile,
        sessionTabs: args.sessionTabs,
        waitForEvent: args.waitForEvent,
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

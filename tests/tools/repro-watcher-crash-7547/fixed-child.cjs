// Fixed-architecture harness for issue #7547: runs the SAME scenarios that
// crash the in-process watcher (see child.cjs), but through the real
// parcel-watcher-process client (esbuild-bundled from src/main/ipc) which
// forks the real out/main/parcel-watcher-process-entry.js.
//
// Success = this process exits 0 (the app-process stand-in survived), the
// watcher stayed functional (final health check receives a live event), and
// no in-process fallback was used. Contained watcher-child crashes are
// EXPECTED and counted — they prove the native bug still fires but no longer
// reaches the host.
//
// Must be run with cwd = repo root (entry path resolves against cwd).
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker, isMainThread, workerData } = require('node:worker_threads')

const REPO_ROOT = path.resolve(__dirname, '..', '..')

// The real host client, bundled on demand so the harness always exercises the
// current src/main/ipc/parcel-watcher-process.ts.
const bundlePath = path.join(__dirname, 'parcel-watcher-process.bundle.cjs')
if (isMainThread) {
  const clientSrc = path.join(REPO_ROOT, 'src', 'main', 'ipc', 'parcel-watcher-process.ts')
  if (
    !fs.existsSync(bundlePath) ||
    fs.statSync(bundlePath).mtimeMs < fs.statSync(clientSrc).mtimeMs
  ) {
    require('node:child_process').execSync(
      `npx esbuild ${JSON.stringify(clientSrc)} --bundle --platform=node --format=cjs ` +
        `--external:electron --external:@parcel/watcher --outfile=${JSON.stringify(bundlePath)}`,
      { cwd: REPO_ROOT, stdio: 'inherit' }
    )
  }
  const entry = path.join(process.cwd(), 'out', 'main', 'parcel-watcher-process-entry.js')
  if (!fs.existsSync(entry)) {
    process.stderr.write(
      `[fixed-harness] missing ${entry}\nRun from the repo root after building (npx electron-vite build).\n`
    )
    process.exit(2)
  }
}
const client = require(bundlePath)

const IGNORE_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'target',
  '.venv',
  '__pycache__'
]
const OPTS = {
  ignore: IGNORE_DIRS.flatMap((dir) => [`**/${dir}`, `**/${dir}/**`]),
  backend: 'windows'
}

const stats = {
  subscribes: 0,
  unsubscribes: 0,
  events: 0,
  watchErrors: 0,
  interruptions: 0,
  containedCrashes: 0,
  fallbackDetected: false
}

// The client reports child crashes / fallback via console.error|warn — hook
// them to count contained crashes and detect a broken (in-process) setup.
const realError = console.error.bind(console)
console.error = (...args) => {
  const line = args.map(String).join(' ')
  if (line.includes('[parcel-watcher-process] watcher process exited')) {
    stats.containedCrashes++
  }
  realError(...args)
}
const realWarn = console.warn.bind(console)
console.warn = (...args) => {
  const line = args.map(String).join(' ')
  if (line.includes('using in-process watcher')) {
    stats.fallbackDetected = true
  }
  realWarn(...args)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (n) => Math.floor(Math.random() * n)

function makeTree(dir, files, subdirs) {
  fs.mkdirSync(dir, { recursive: true })
  const dirs = [dir]
  for (let d = 0; d < subdirs; d++) {
    const sub = path.join(dir, `sub-${d}`)
    fs.mkdirSync(sub, { recursive: true })
    dirs.push(sub)
  }
  for (const d of dirs) {
    for (let f = 0; f < Math.ceil(files / dirs.length); f++) {
      fs.writeFileSync(path.join(d, `f${f}.txt`), 'seed')
    }
  }
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  } catch {}
}

if (!isMainThread && workerData && workerData.role === 'churn') {
  const { dir, durationMs } = workerData
  const end = Date.now() + durationMs
  let i = 0
  while (Date.now() < end) {
    const a = path.join(dir, `churn-${i % 200}.txt`)
    const b = path.join(dir, `churn-${i % 200}.renamed.txt`)
    try {
      fs.writeFileSync(a, `payload-${i}`)
      fs.renameSync(a, b)
      fs.rmSync(b, { force: true })
    } catch {
      if (i % 500 === 0) {
        try {
          fs.mkdirSync(dir, { recursive: true })
        } catch {}
      }
    }
    i++
  }
  process.exit(0)
}

function subscribeLikeOrca(dir) {
  let subRef = { current: null }
  stats.subscribes++
  return client
    .subscribeViaWatcherProcess(
      dir,
      (err, events) => {
        if (err) {
          stats.watchErrors++
          // Orca's error path: unsubscribe from inside the error callback.
          if (subRef.current) {
            stats.unsubscribes++
            subRef.current.unsubscribe().catch(() => {})
            subRef.current = null
          }
          return
        }
        stats.events += events.length
      },
      OPTS,
      () => {
        stats.interruptions++
      }
    )
    .then((sub) => {
      subRef.current = sub
      return subRef
    })
}

async function deleteRootLane(baseDir, durationMs, lane) {
  const end = Date.now() + durationMs
  let round = 0
  while (Date.now() < end) {
    const dir = path.join(baseDir, `wt-${lane}-${round}`)
    makeTree(dir, 120, 4)
    let subRef
    try {
      subRef = await subscribeLikeOrca(dir)
    } catch {
      rmrf(dir)
      round++
      continue
    }
    const churn = new Worker(__filename, {
      workerData: { role: 'churn', dir, durationMs: 300 }
    })
    // Attach at spawn: a listener added after the worker already exited never
    // fires, which hangs the lane (or lets the process exit 0 mid-run).
    const churnDone = new Promise((r) => churn.once('exit', r))
    await sleep(50 + rand(100))
    rmrf(dir)
    await sleep(rand(60))
    if (subRef.current) {
      stats.unsubscribes++
      await subRef.current.unsubscribe().catch(() => {})
      subRef.current = null
    }
    await churnDone
    rmrf(dir)
    round++
  }
}

async function unsubChurnLane(baseDir, durationMs, lane) {
  const dir = path.join(baseDir, `unsub-${lane}`)
  makeTree(dir, 150, 3)
  const churn = new Worker(__filename, {
    workerData: { role: 'churn', dir, durationMs }
  })
  const churnDone = new Promise((r) => churn.once('exit', r))
  const end = Date.now() + durationMs
  while (Date.now() < end) {
    let subRef
    try {
      subRef = await subscribeLikeOrca(dir)
    } catch {
      await sleep(20)
      continue
    }
    await sleep(rand(50))
    if (subRef.current) {
      stats.unsubscribes++
      const p = subRef.current.unsubscribe().catch(() => {})
      subRef.current = null
      if (rand(2) === 0) {
        await p
      }
    }
  }
  await churnDone
  rmrf(dir)
}

// Health check must outlast the client's 30s crash-loop cooldown: if the
// breaker tripped during the scenarios, watching is expected to recover on a
// later subscribe, and THAT is what we verify.
async function finalHealthCheck(baseDir) {
  const deadline = Date.now() + 45_000
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    const dir = path.join(baseDir, `health-${attempt}`)
    makeTree(dir, 5, 0)
    let gotEvent = false
    let sub = null
    try {
      sub = await client.subscribeViaWatcherProcess(
        dir,
        (err, events) => {
          if (!err && events.length > 0) {
            gotEvent = true
          }
        },
        OPTS
      )
    } catch (err) {
      process.stderr.write(
        `[fixed-harness] health subscribe attempt ${attempt} failed: ${err.message}\n`
      )
      rmrf(dir)
      await sleep(5000)
      continue
    }
    const probeDeadline = Date.now() + 8000
    while (!gotEvent && Date.now() < probeDeadline) {
      fs.writeFileSync(path.join(dir, 'probe.txt'), `probe-${Date.now()}`)
      await sleep(200)
    }
    await sub.unsubscribe().catch(() => {})
    rmrf(dir)
    if (gotEvent) {
      return true
    }
    process.stderr.write(`[fixed-harness] health attempt ${attempt}: no events in 8s; retrying\n`)
    await sleep(3000)
  }
  return false
}

let completed = false

async function main() {
  const durationMs = Number(process.argv[2] || 15000)
  const baseDir = path.join(os.tmpdir(), 'orca-7547-harness-fixed', `run-${process.pid}`)
  fs.mkdirSync(baseDir, { recursive: true })

  // Watchdog: a stuck lane must fail loudly, and a premature natural exit
  // (empty event loop) must not read as success.
  const watchdog = setTimeout(
    () => {
      process.stderr.write('[fixed-harness] FAIL: watchdog — scenarios did not complete\n')
      process.exit(7)
    },
    durationMs * 4 + 60_000
  )
  process.on('exit', (code) => {
    if (!completed && code === 0) {
      process.exitCode = 8
      process.stderr.write('[fixed-harness] FAIL: premature exit before completion\n')
    }
  })

  const lanes = []
  for (let lane = 0; lane < 6; lane++) {
    lanes.push(deleteRootLane(baseDir, durationMs, lane))
  }
  for (let lane = 0; lane < 6; lane++) {
    lanes.push(unsubChurnLane(baseDir, durationMs, lane))
  }
  await Promise.all(lanes)

  const healthy = await finalHealthCheck(baseDir)
  client.disposeWatcherProcess()
  rmrf(baseDir)
  completed = true
  clearTimeout(watchdog)

  // Summary via stderr + exitCode (not process.exit): stdout writes to a pipe
  // are async on Windows and process.exit() drops them.
  process.stderr.write(
    `[fixed-harness] subs=${stats.subscribes} unsubs=${stats.unsubscribes} events=${stats.events} ` +
      `watchErrors=${stats.watchErrors} containedCrashes=${stats.containedCrashes} ` +
      `interruptions=${stats.interruptions} healthy=${healthy} fallback=${stats.fallbackDetected}\n`
  )
  if (stats.fallbackDetected) {
    process.stderr.write(
      '[fixed-harness] FAIL: in-process fallback used — isolation not exercised\n'
    )
    process.exitCode = 6
    return
  }
  if (!healthy) {
    process.stderr.write('[fixed-harness] FAIL: watcher not functional after scenarios\n')
    process.exitCode = 5
    return
  }
  process.stderr.write('[fixed-harness] PASS: host survived; watcher functional\n')
  process.exitCode = 0
}

if (isMainThread) {
  main().catch((err) => {
    console.error('[fixed-harness] harness error:', err)
    process.exit(3)
  })
}

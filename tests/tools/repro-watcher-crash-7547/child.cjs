// #7547 watcher.node 0xc0000409 repro; parent repeats one child scenario and reports native exit codes.
// delete-root races watched-root deletion/error callbacks; unsub-churn overlaps watch teardown; worker-mix recycles threads sharing native Watcher;
// overflow forces ReadDirectoryChangesW buffer pressure with long-name churn; mixed combines them. Exit 0 means this scenario survived.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker, isMainThread, workerData } = require('node:worker_threads')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
// The exact bundled native module (@parcel/watcher 2.5.6 + watcher-win32-x64).
const watcherPath = path.join(REPO_ROOT, 'node_modules', '@parcel', 'watcher')

// Match production win32 ignore options so main/worker subscriptions share the same native Watcher key.
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
const IGNORE = IGNORE_DIRS.flatMap((dir) => [`**/${dir}`, `**/${dir}/**`])
const OPTS = { ignore: IGNORE, backend: 'windows' }

const stats = {
  eventBatches: 0,
  events: 0,
  errors: 0,
  errorMessages: new Map(),
  subscribes: 0,
  unsubscribes: 0,
  workersSpawned: 0,
  workersTerminated: 0
}

function log(msg) {
  process.stderr.write(`[child ${process.pid}] ${msg}\n`)
}

function recordError(err) {
  stats.errors++
  const msg = String((err && err.message) || err)
  stats.errorMessages.set(msg, (stats.errorMessages.get(msg) || 0) + 1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (n) => Math.floor(Math.random() * n)

function makeTree(dir, files, subdirs, nameLen) {
  fs.mkdirSync(dir, { recursive: true })
  const dirs = [dir]
  for (let d = 0; d < subdirs; d++) {
    const sub = path.join(dir, `sub-${d}`)
    fs.mkdirSync(sub, { recursive: true })
    dirs.push(sub)
  }
  let made = 0
  for (const d of dirs) {
    for (let f = 0; f < Math.ceil(files / dirs.length); f++) {
      const pad = 'x'.repeat(Math.max(0, nameLen - 12))
      fs.writeFileSync(path.join(d, `f${f}-${pad}.txt`), 'seed')
      made++
    }
  }
  return made
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  } catch {
    // Watched dirs can be locked mid-delete on Windows; partial deletes still
    // generate the event storm we want.
  }
}

if (!isMainThread && workerData && workerData.role === 'churn') {
  // Churn synchronously until stop, tolerating root deletion as part of the scenario.
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
      // Root may be mid-delete; recreate it occasionally to keep churn alive.
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

if (!isMainThread && workerData && workerData.role === 'subscriber') {
  // Watch the main env’s same directory from a worker, then tear down per mode.
  const { dir, mode, holdMs } = workerData
  const watcher = require(watcherPath)
  ;(async () => {
    let sub
    try {
      sub = await watcher.subscribe(dir, () => {}, OPTS)
    } catch {
      process.exit(0)
    }
    await sleep(holdMs)
    if (mode === 'clean') {
      try {
        await sub.unsubscribe()
      } catch {}
      process.exit(0)
    }
    if (mode === 'dirty-exit') {
      // Exit without unsubscribe, retaining the callback in process-global native Watcher.
      process.exit(0)
    }
    // Linger for terminate() to race subscription/unsubscribe.
    await sleep(60_000)
  })()
}

async function scenarioDeleteRoot(watcher, baseDir, durationMs, lane) {
  const end = Date.now() + durationMs
  let round = 0
  while (Date.now() < end) {
    const dir = path.join(baseDir, `wt-${lane}-${round}`)
    makeTree(dir, 120, 4, 20)
    let sub = null
    let errored = false
    try {
      stats.subscribes++
      sub = await watcher.subscribe(
        dir,
        (err, events) => {
          if (err) {
            recordError(err)
            errored = true
            // Mirror createWatcher’s unsubscribe inside its error callback.
            if (sub) {
              stats.unsubscribes++
              sub.unsubscribe().catch(() => {})
            }
            return
          }
          stats.eventBatches++
          stats.events += events.length
        },
        OPTS
      )
    } catch (err) {
      recordError(err)
      rmrf(dir)
      round++
      continue
    }
    // Churn briefly, then delete the watched root while events are flowing.
    const churn = new Worker(__filename, {
      workerData: { role: 'churn', dir, durationMs: 300 }
    })
    await sleep(50 + rand(100))
    rmrf(dir)
    await sleep(rand(60))
    if (!errored && sub) {
      stats.unsubscribes++
      await sub.unsubscribe().catch(() => {})
    }
    await new Promise((r) => churn.once('exit', r))
    rmrf(dir)
    round++
  }
}

async function scenarioUnsubChurn(watcher, baseDir, durationMs, lane) {
  const dir = path.join(baseDir, `unsub-${lane}`)
  makeTree(dir, 150, 3, 20)
  const churn = new Worker(__filename, {
    workerData: { role: 'churn', dir, durationMs }
  })
  const end = Date.now() + durationMs
  while (Date.now() < end) {
    let sub
    try {
      stats.subscribes++
      sub = await watcher.subscribe(
        dir,
        (err, events) => {
          if (err) {
            recordError(err)
            return
          }
          stats.eventBatches++
          stats.events += events.length
        },
        OPTS
      )
    } catch (err) {
      recordError(err)
      continue
    }
    await sleep(rand(50))
    stats.unsubscribes++
    // Skip half the unsubscribe awaits to race grace teardown against re-watch.
    if (rand(2) === 0) {
      await sub.unsubscribe().catch(() => {})
    } else {
      sub.unsubscribe().catch(() => {})
    }
  }
  await new Promise((r) => churn.once('exit', r))
  rmrf(dir)
}

async function scenarioWorkerMix(watcher, baseDir, durationMs, lane) {
  const dir = path.join(baseDir, `wmix-${lane}`)
  makeTree(dir, 100, 3, 20)
  // Main env holds a long-lived subscription (desktop explorer watch).
  let mainSub = null
  try {
    stats.subscribes++
    mainSub = await watcher.subscribe(
      dir,
      (err, events) => {
        if (err) {
          recordError(err)
          return
        }
        stats.eventBatches++
        stats.events += events.length
      },
      OPTS
    )
  } catch (err) {
    recordError(err)
  }
  const churn = new Worker(__filename, {
    workerData: { role: 'churn', dir, durationMs }
  })
  const end = Date.now() + durationMs
  while (Date.now() < end) {
    const mode = ['clean', 'dirty-exit', 'wait-terminate'][rand(3)]
    const worker = new Worker(__filename, {
      workerData: { role: 'subscriber', dir, mode, holdMs: rand(150) }
    })
    stats.workersSpawned++
    const exited = new Promise((r) => worker.once('exit', r))
    worker.once('error', () => {})
    if (mode === 'wait-terminate') {
      await sleep(rand(100))
      stats.workersTerminated++
      await worker.terminate().catch(() => {})
    }
    await Promise.race([exited, sleep(1000)])
  }
  await new Promise((r) => churn.once('exit', r))
  if (mainSub) {
    stats.unsubscribes++
    await mainSub.unsubscribe().catch(() => {})
  }
  rmrf(dir)
}

async function scenarioOverflow(watcher, baseDir, durationMs, lane) {
  const end = Date.now() + durationMs
  let round = 0
  while (Date.now() < end) {
    const dir = path.join(baseDir, `ovf-${lane}-${round}`)
    // Long names fill the 1MB ReadDirectoryChangesW buffer faster.
    makeTree(dir, 4000, 8, 180)
    let sub = null
    try {
      stats.subscribes++
      sub = await watcher.subscribe(
        dir,
        (err, events) => {
          if (err) {
            recordError(err)
            if (sub) {
              stats.unsubscribes++
              sub.unsubscribe().catch(() => {})
            }
            return
          }
          stats.eventBatches++
          stats.events += events.length
        },
        OPTS
      )
    } catch (err) {
      recordError(err)
      rmrf(dir)
      round++
      continue
    }
    // Combine recursive delete and churn workers into dense backend stat/event load.
    const churners = Array.from(
      { length: 3 },
      () => new Worker(__filename, { workerData: { role: 'churn', dir, durationMs: 500 } })
    )
    rmrf(dir)
    await Promise.all(churners.map((w) => new Promise((r) => w.once('exit', r))))
    if (sub) {
      stats.unsubscribes++
      await sub.unsubscribe().catch(() => {})
    }
    rmrf(dir)
    round++
  }
}

// Minimize delete-root: del-nounsub omits unsubscribe, del-nochurn omits churn, del-1lane serializes the full pattern.
async function scenarioDeleteMinimal(watcher, baseDir, durationMs, lane, { churn, unsub }) {
  const end = Date.now() + durationMs
  let round = 0
  while (Date.now() < end) {
    const dir = path.join(baseDir, `min-${lane}-${round}`)
    makeTree(dir, 120, 4, 20)
    let sub = null
    try {
      stats.subscribes++
      sub = await watcher.subscribe(
        dir,
        (err, events) => {
          if (err) {
            recordError(err)
            return
          }
          stats.eventBatches++
          stats.events += events.length
        },
        OPTS
      )
    } catch (err) {
      recordError(err)
      rmrf(dir)
      round++
      continue
    }
    let churnWorker = null
    if (churn) {
      churnWorker = new Worker(__filename, {
        workerData: { role: 'churn', dir, durationMs: 300 }
      })
      await sleep(50 + rand(100))
    }
    rmrf(dir)
    await sleep(100)
    if (unsub && sub) {
      stats.unsubscribes++
      await sub.unsubscribe().catch(() => {})
    }
    if (churnWorker) {
      await new Promise((r) => churnWorker.once('exit', r))
    }
    rmrf(dir)
    round++
  }
}

const SCENARIOS = {
  'delete-root': { fn: scenarioDeleteRoot, lanes: 6 },
  'del-nounsub': {
    fn: (w, b, d, l) => scenarioDeleteMinimal(w, b, d, l, { churn: true, unsub: false }),
    lanes: 6
  },
  'del-nochurn': {
    fn: (w, b, d, l) => scenarioDeleteMinimal(w, b, d, l, { churn: false, unsub: false }),
    lanes: 6
  },
  'del-1lane': {
    fn: (w, b, d, l) => scenarioDeleteMinimal(w, b, d, l, { churn: true, unsub: true }),
    lanes: 1
  },
  'unsub-churn': { fn: scenarioUnsubChurn, lanes: 6 },
  'worker-mix': { fn: scenarioWorkerMix, lanes: 4 },
  overflow: { fn: scenarioOverflow, lanes: 2 }
}

async function main() {
  const scenarioName = process.argv[2] || 'mixed'
  const durationMs = Number(process.argv[3] || 15000)
  // Keep churn outside the worktree so a live Orca watcher cannot observe it.
  const baseDir = path.join(os.tmpdir(), 'orca-7547-harness', `run-${process.pid}`)
  fs.mkdirSync(baseDir, { recursive: true })

  const watcher = require(watcherPath)
  const jobs = []
  const names = scenarioName === 'mixed' ? Object.keys(SCENARIOS) : [scenarioName]
  for (const name of names) {
    const s = SCENARIOS[name]
    if (!s) {
      log(`unknown scenario: ${name}`)
      process.exit(2)
    }
    const lanes = scenarioName === 'mixed' ? Math.max(1, Math.floor(s.lanes / 2)) : s.lanes
    for (let lane = 0; lane < lanes; lane++) {
      jobs.push(s.fn(watcher, baseDir, durationMs, lane))
    }
  }
  await Promise.all(jobs)

  const errs = Array.from(stats.errorMessages.entries())
    .map(([m, n]) => `${n}x "${m}"`)
    .join(', ')
  log(
    `done: subs=${stats.subscribes} unsubs=${stats.unsubscribes} batches=${stats.eventBatches} ` +
      `events=${stats.events} errors=${stats.errors} workers=${stats.workersSpawned} ` +
      `terminated=${stats.workersTerminated}${errs ? ` errMsgs: ${errs}` : ''}`
  )
  rmrf(baseDir)
  process.exit(0)
}

if (isMainThread) {
  main().catch((err) => {
    log(`harness error: ${err && err.stack}`)
    process.exit(3)
  })
}

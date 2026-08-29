import { strict as assert } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  cadenceSummary,
  classifyProcessStart,
  decodePowerShellCommand
} from './consumer-classifier.mjs'
import {
  initializeOracleOutputDirectory,
  trackChildExit,
  waitForObserverReady,
  waitForSuccessfulChildExit
} from './oracle-lifecycle.mjs'
import {
  attemptedStartsForWindow,
  correlateObserverStarts,
  exactStartsForWindow
} from './observer-spawn-cross-check.mjs'
import { collectRendererWindowMetrics } from './renderer-window-probe.mjs'

const encoded = Buffer.from(
  'Get-CimInstance Win32_Process -Property PageFileUsage',
  'utf16le'
).toString('base64')
assert.match(decodePowerShellCommand(`powershell -EncodedCommand ${encoded}`), /PageFileUsage/)
assert.equal(
  classifyProcessStart({ name: 'powershell.exe', commandLine: `powershell -enc ${encoded}` }),
  'memory-collector'
)
assert.equal(
  classifyProcessStart({ name: 'powershell.exe', commandLine: 'powershell -c whoami' }),
  'unknown-powershell'
)
assert.equal(
  classifyProcessStart({ name: 'netstat', commandLine: 'netstat -ano -p tcp' }),
  'port-scan-netstat'
)
assert.deepEqual(
  cadenceSummary([
    { timestamp: '2026-01-01T00:00:00.000Z' },
    { timestamp: '2026-01-01T00:00:02.000Z' },
    { timestamp: '2026-01-01T00:00:04.100Z' }
  ]).intervalsMs,
  [2000, 2100]
)

const lifecycleDir = mkdtempSync(path.join(tmpdir(), 'orca-process-oracle-lifecycle-'))
try {
  initializeOracleOutputDirectory(lifecycleDir)
  writeFileSync(path.join(lifecycleDir, 'z-stale'), '')
  writeFileSync(path.join(lifecycleDir, 'a-stale'), '')
  assert.throws(
    () => initializeOracleOutputDirectory(lifecycleDir),
    /stale artifacts: a-stale, z-stale/
  )

  const exitedChild = new EventEmitter()
  const immediateExit = trackChildExit(exitedChild)
  exitedChild.emit('exit', 0, null)
  await waitForSuccessfulChildExit(immediateExit, 'fixture child', 100)

  const failedChild = new EventEmitter()
  const failedExit = trackChildExit(failedChild)
  failedChild.emit('exit', 7, null)
  await assert.rejects(
    waitForObserverReady({
      readyPath: path.join(lifecycleDir, 'never-ready'),
      exit: failedExit,
      timeoutMs: 100
    }),
    /exited before becoming ready: code 7/
  )
  await assert.rejects(
    waitForSuccessfulChildExit(new Promise(() => {}), 'wedged child', 20),
    /did not exit within 20ms/
  )

  const roots = new Set([10])
  const exact = exactStartsForWindow(
    [
      {
        type: 'spawn',
        timestamp: '2026-01-01T00:00:01.000Z',
        parentPid: 10,
        returnedPid: 20,
        executable: 'powershell.exe',
        argv: ['powershell.exe', '-NoProfile']
      },
      {
        type: 'spawn',
        timestamp: '2026-01-01T00:00:02.000Z',
        parentPid: 10,
        returnedPid: 21,
        executable: 'node.exe',
        argv: ['node.exe', 'brief.js']
      }
    ],
    roots,
    Date.parse('2026-01-01T00:00:00.000Z'),
    Date.parse('2026-01-01T00:00:03.000Z')
  )
  const crossCheck = correlateObserverStarts(
    [
      { pid: 20, timestamp: '2026-01-01T00:00:01.025Z' },
      { pid: 22, timestamp: '2026-01-01T00:00:02.025Z' }
    ],
    exact
  )
  assert.equal(crossCheck.complete, false)
  assert.deepEqual(
    crossCheck.unmatchedObserverStarts.map((row) => row.pid),
    [22]
  )
  assert.deepEqual(
    crossCheck.unobservedExactStarts.map((row) => row.returnedPid),
    [21]
  )
  const attempts = attemptedStartsForWindow(
    [
      ...exact,
      {
        type: 'spawn-error',
        timestamp: '2026-01-01T00:00:02.500Z',
        parentPid: 10,
        returnedPid: null,
        executable: 'powershell.exe',
        argv: ['powershell.exe', '-NoProfile']
      }
    ],
    roots,
    Date.parse('2026-01-01T00:00:00.000Z'),
    Date.parse('2026-01-01T00:00:03.000Z')
  )
  assert.equal(attempts.length, 3)
  assert.equal(attempts.at(-1).consumer, 'unknown-powershell')

  const previousWindow = globalThis.window
  try {
    globalThis.window = {
      api: { pty: { confirmForegroundProcess: async () => 'stable-shell' } }
    }
    const settled = await collectRendererWindowMetrics({
      windowMs: 30,
      ptyId: 'pty-seam',
      eventLoopIntervalMs: 5,
      foregroundPollMs: 100,
      probeSettleTimeoutMs: 20
    })
    assert.equal(settled.foregroundProbe.results.length, 1)
    assert.equal(settled.foregroundProbe.results[0].requestId, 1)
    assert.equal(typeof settled.foregroundProbe.results[0].finishedAt, 'number')

    globalThis.window = {
      api: {
        pty: {
          confirmForegroundProcess: () => {
            throw new Error('synchronous probe failure')
          }
        }
      }
    }
    const rejected = await collectRendererWindowMetrics({
      windowMs: 20,
      ptyId: 'pty-rejected',
      collectEventLoop: false,
      foregroundPollMs: 100,
      probeSettleTimeoutMs: 20
    })
    assert.match(rejected.foregroundProbe.results[0].error, /synchronous probe failure/)
    assert.equal(typeof rejected.foregroundProbe.results[0].finishedAt, 'number')

    globalThis.window = {
      api: { pty: { confirmForegroundProcess: () => new Promise(() => {}) } }
    }
    await assert.rejects(
      collectRendererWindowMetrics({
        windowMs: 20,
        ptyId: 'pty-wedged',
        collectEventLoop: false,
        foregroundPollMs: 100,
        probeSettleTimeoutMs: 20
      }),
      /foreground probes did not settle within 20ms: 1/
    )
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window
    } else {
      globalThis.window = previousWindow
    }
  }
} finally {
  rmSync(lifecycleDir, { recursive: true, force: true })
}

if (process.platform === 'win32') {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-process-oracle-'))
  const output = path.join(dir, 'starts.ndjson')
  const ready = path.join(dir, 'ready')
  const stop = path.join(dir, 'stop')
  const watcher = spawn(
    process.execPath,
    [
      path.join(import.meta.dirname, 'process-snapshot-watch.mjs'),
      '--output',
      output,
      '--ready',
      ready,
      '--stop',
      stop,
      '--duration-ms',
      '5000'
    ],
    { stdio: 'inherit', windowsHide: true }
  )
  const watcherExit = trackChildExit(watcher)
  await waitForObserverReady({ readyPath: ready, exit: watcherExit, timeoutMs: 5_000 })
  const fixture = spawn(
    process.execPath,
    [path.join(import.meta.dirname, 'process-start-fixture.mjs'), '3', '400'],
    {
      stdio: 'inherit',
      windowsHide: true
    }
  )
  await new Promise((resolve, reject) =>
    fixture.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))
    )
  )
  writeFileSync(stop, '', { flag: 'wx' })
  await waitForSuccessfulChildExit(watcherExit, 'native observer fixture', 10_000)
  const rows = readFileSync(output, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const observerSummary = rows.find((row) => row.type === 'summary')
  assert.equal(observerSummary.durationLimitMs, 5_000)
  assert.equal(observerSummary.stoppedByMarker, true)
  assert.ok(observerSummary.durationMs < observerSummary.durationLimitMs)
  const fixtureRows = rows.filter(
    (row) => row.parentPid === fixture.pid && row.name.toLowerCase() === 'node.exe'
  )
  assert.equal(fixtureRows.length, 3)
  assert.ok(fixtureRows.every((row) => row.argvCaptureStatus === 'captured'))

  const spawnDir = path.join(dir, 'spawn-calls')
  mkdirSync(spawnDir)
  const exactFixture = spawn(
    process.execPath,
    [path.join(import.meta.dirname, 'process-start-fixture.mjs'), '20', '0', '0'],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${path.join(import.meta.dirname, 'spawn-call-probe.cjs')}`,
        ORCA_PROCESS_ORACLE_SPAWN_DIR: spawnDir
      },
      stdio: 'inherit',
      windowsHide: true
    }
  )
  await new Promise((resolve, reject) =>
    exactFixture.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`exact fixture exited ${code}`))
    )
  )
  const exactRows = readFileSync(path.join(spawnDir, `${exactFixture.pid}.ndjson`), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse)
  const exactStarts = exactRows.filter((row) => row.type === 'spawn')
  assert.equal(exactStarts.length, 20)
  assert.ok(exactStarts.every((row) => Number.isInteger(row.returnedPid)))
  assert.ok(exactStarts.every((row) => row.stack.includes('process-start-fixture.mjs')))

  const filesBeforeSyncFixture = new Set(readdirSync(spawnDir))
  execFileSync(
    process.execPath,
    ['-e', "require('node:child_process').execFileSync(process.execPath, ['-e', '0'])"],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${path.join(import.meta.dirname, 'spawn-call-probe.cjs')}`,
        ORCA_PROCESS_ORACLE_SPAWN_DIR: spawnDir
      }
    }
  )
  const syncRows = readdirSync(spawnDir)
    .filter((file) => !filesBeforeSyncFixture.has(file))
    .flatMap((file) =>
      readFileSync(path.join(spawnDir, file), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    )
  const syncStarts = syncRows.filter((row) => row.type === 'spawn-sync')
  assert.equal(syncStarts.length, 1)
  assert.ok(Number.isInteger(syncStarts[0].returnedPid))
  assert.ok(syncStarts[0].stack.includes('[eval]'))

  const filesBeforeWorkerFixture = new Set(readdirSync(spawnDir))
  execFileSync(
    process.execPath,
    [
      '-e',
      `const { Worker } = require('node:worker_threads'); const worker = new Worker(${JSON.stringify(
        "require('node:child_process').execFileSync(process.execPath, ['-e', '0'])"
      )}, { eval: true }); worker.on('exit', (code) => { process.exitCode = code })`
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${path.join(import.meta.dirname, 'spawn-call-probe.cjs')}`,
        ORCA_PROCESS_ORACLE_SPAWN_DIR: spawnDir
      }
    }
  )
  const workerRows = readdirSync(spawnDir)
    .filter((file) => !filesBeforeWorkerFixture.has(file))
    .flatMap((file) =>
      readFileSync(path.join(spawnDir, file), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    )
  const workerStarts = workerRows.filter((row) => row.type === 'spawn-sync')
  assert.equal(workerStarts.length, 1)
  assert.ok(workerStarts[0].threadId > 0)
  assert.ok(workerStarts[0].stack.includes('[worker eval]'))
  expectPreloadedThreadIds(workerRows, workerStarts[0].parentPid, [0, workerStarts[0].threadId])
}

function expectPreloadedThreadIds(rows, parentPid, expectedThreadIds) {
  assert.deepEqual(
    rows
      .filter((row) => row.type === 'preload' && row.parentPid === parentPid)
      .map((row) => row.threadId)
      .sort((left, right) => left - right),
    expectedThreadIds
  )
}

console.log('windows-process-polling-oracle tests passed')

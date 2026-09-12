#!/usr/bin/env node
/**
 * Orca terminal-daemon RSS measurement under PTY churn (STA-3515).
 *
 * Measures whether daemon memory grows without bound across repeated PTY
 * create/output/kill cycles, and separates:
 *   - the NATURAL series: RSS + V8 heap sampled with NO forced GC, so transient
 *     JS retention stays visible;
 *   - the FORCED-GC series: a separate daemon run where GC is forced via the
 *     inspector immediately before every sample, showing the reclaimable floor.
 * The natural run additionally takes one clearly-labelled post-run forced-GC
 * sample, which is the leak-vs-retention discriminator: memory that survives a
 * final full GC after all sessions are dead is either allocator retention or a
 * real leak; memory that drops was transient JS retention.
 *
 * Every run starts with the build-provenance gate in
 * daemon-build-provenance-gate.mjs, which FAILS LOUDLY unless the daemon
 * bundle and the patched node-pty binaries are provably built from the
 * checked-out HEAD.
 *
 * The daemon is spawned with `--inspect=0` (ephemeral port). The inspector URL
 * is taken from the child's own stderr — never from a fixed port — and
 * ownership is asserted by evaluating `process.pid` over the socket and
 * comparing it to the spawned child's pid before any measurement.
 *
 * Usage:
 *   node tests/tools/benchmarks/daemon-pty-churn-rss-bench.mjs --label baseline
 *     [--cycles 400] [--sample-every 20] [--output-bytes 65536]
 *     [--series both|natural|forced-gc] [--settle-ms 30] [--probe-fds]
 *
 * Results: tests/tools/benchmarks/results/daemon-pty-churn-rss-<label>-<stamp>.json
 */
import { execFileSync, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertDaemonBuildProvenance } from './daemon-build-provenance-gate.mjs'
import { BenchDaemonClient, RPC_TIMEOUT_MS, withTimeout } from './daemon-bench-ndjson-client.mjs'
import { InspectorSession, waitForInspectorUrl } from './daemon-bench-inspector-session.mjs'

const scriptDir = import.meta.dirname
const repoRoot = resolve(scriptDir, '..', '..', '..')
const DAEMON_BUNDLE = join(repoRoot, 'out', 'orcad', 'daemon-entry.js')
const READY_TIMEOUT_MS = 20_000

function parseArgs(argv) {
  const args = {
    label: 'run',
    cycles: 400,
    sampleEvery: 20,
    outputBytes: 65_536,
    series: 'both',
    settleMs: 30,
    probeFds: false
  }
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i]
    const num = (name) => {
      const value = Number(next())
      // Integers only: a fractional cadence samples erratically through `%`,
      // and fractional byte/cycle counts have no meaning here.
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} requires a non-negative integer`)
      }
      return value
    }
    switch (argv[i]) {
      case '--label':
        args.label = next()
        break
      case '--cycles':
        args.cycles = num('--cycles')
        // Zero cycles churns nothing: the loop never runs, `samples` holds only the
        // baseline, and the summary reports a flat zero-growth series from no work.
        if (args.cycles === 0) {
          throw new Error('--cycles requires a positive integer')
        }
        break
      case '--sample-every':
        args.sampleEvery = num('--sample-every')
        // `cycle % 0` is NaN: the run would complete with only the baseline
        // sample and summarize as a plausible-looking zero-growth series.
        if (args.sampleEvery === 0) {
          throw new Error('--sample-every requires a positive integer')
        }
        break
      case '--output-bytes':
        args.outputBytes = num('--output-bytes')
        // Zero bytes leaves `command` null, so every cycle degenerates to bare
        // create+kill and the RSS series flattens for lack of churn, not for lack of a leak.
        if (args.outputBytes === 0) {
          throw new Error('--output-bytes requires a positive integer')
        }
        break
      case '--settle-ms':
        args.settleMs = num('--settle-ms')
        break
      case '--series':
        args.series = next()
        if (!['both', 'natural', 'forced-gc'].includes(args.series)) {
          throw new Error('--series must be both, natural, or forced-gc')
        }
        break
      case '--probe-fds':
        args.probeFds = true
        break
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return args
}

function readProtocolVersion() {
  const source = readFileSync(
    join(repoRoot, 'src', 'main', 'daemon', 'daemon-protocol-version.ts'),
    'utf8'
  )
  const match = /export const PROTOCOL_VERSION = (\d+)/.exec(source)
  if (!match) {
    throw new Error('could not read PROTOCOL_VERSION from daemon-protocol-version.ts')
  }
  return Number(match[1])
}

function shellForPlatform() {
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
}

function outputCommand(outputBytes) {
  // node one-liner so output generation is identical on every platform.
  return `"${process.execPath}" -e "process.stdout.write('x'.repeat(${outputBytes}))"`
}

function sampleFdCounts(pid) {
  if (process.platform !== 'darwin') {
    return null
  }
  try {
    const lines = execFileSync('lsof', ['-nP', '-p', String(pid)], { encoding: 'utf8' })
      .trimEnd()
      .split('\n')
      .slice(1)
    return {
      fds: lines.length,
      kqueues: lines.filter((line) => line.includes(' KQUEUE ')).length,
      ptmx: lines.filter((line) => line.includes('/dev/ptmx')).length
    }
  } catch {
    return null
  }
}

function memorySample(seriesName, forcedGc, cycles, startedAt, memory) {
  return {
    series: seriesName,
    forcedGc,
    cycles,
    elapsedMs: Date.now() - startedAt,
    rssKb: Math.round(memory.rss / 1024),
    heapUsedKb: Math.round(memory.heapUsed / 1024),
    heapTotalKb: Math.round(memory.heapTotal / 1024),
    externalKb: Math.round(memory.external / 1024),
    arrayBuffersKb: Math.round(memory.arrayBuffers / 1024)
  }
}

async function runSeries({ seriesName, args, protocolVersion, forceGcBeforeSample }) {
  const runDir = mkdtempSync(join(os.tmpdir(), 'orca-rss-bench-'))
  const nonce = randomUUID().slice(0, 8)
  const socketPath =
    process.platform === 'win32'
      ? `\\\\?\\pipe\\orca-rss-bench-${nonce}`
      : join(runDir, 'daemon.sock')
  const tokenPath = join(runDir, 'daemon.token')

  const child = fork(DAEMON_BUNDLE, ['--socket', socketPath, '--token', tokenPath], {
    cwd: repoRoot,
    env: { ...process.env, ORCA_USER_DATA_PATH: runDir },
    execArgv: ['--inspect=0'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  const childPid = child.pid
  let childExited = false
  child.once('exit', () => {
    childExited = true
  })
  let stderrTail = ''
  const inspectorUrlPromise = waitForInspectorUrl(child)
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192)
  })

  const outputCharsBySession = new Map()
  const client = new BenchDaemonClient(socketPath, tokenPath, protocolVersion, (sessionId, chars) =>
    outputCharsBySession.set(sessionId, (outputCharsBySession.get(sessionId) ?? 0) + chars)
  )
  const samples = []
  const startedAt = Date.now()
  // Inside the try: a rejected inspector-URL wait (timeout, early child exit)
  // must still reach the finally that kills the child and removes runDir.
  let inspector = null
  try {
    inspector = new InspectorSession(await inspectorUrlPromise)
    await withTimeout(
      new Promise((resolvePromise, reject) => {
        child.once('message', (message) => {
          if (message?.type === 'ready') {
            resolvePromise()
          } else {
            reject(new Error(`unexpected first daemon message: ${JSON.stringify(message)}`))
          }
        })
        child.once('exit', (code) => reject(new Error(`daemon exited before ready: ${code}`)))
      }),
      READY_TIMEOUT_MS,
      'daemon ready'
    )

    await inspector.connect()
    // Ownership assertion: the inspector target MUST be the daemon we spawned.
    const reportedPid = await inspector.evaluateJson('process.pid')
    if (reportedPid !== childPid) {
      throw new Error(
        `PROVENANCE FAILURE: inspector target pid ${reportedPid} != spawned daemon pid ${childPid}; refusing to measure an unrelated process`
      )
    }

    await client.connect()

    const takeSample = async (cycles) => {
      if (forceGcBeforeSample) {
        await inspector.send('HeapProfiler.collectGarbage')
        await delay(50)
      }
      const memory = await inspector.evaluateJson('process.memoryUsage()')
      samples.push({
        ...memorySample(seriesName, forceGcBeforeSample, cycles, startedAt, memory),
        ...(args.probeFds ? { fdCounts: sampleFdCounts(childPid) } : {})
      })
    }

    await takeSample(0)
    const command = args.outputBytes > 0 ? outputCommand(args.outputBytes) : null
    let fullOutputCycles = 0
    let shortOutputCycles = 0
    for (let cycle = 1; cycle <= args.cycles; cycle++) {
      const sessionId = `rss-bench-${seriesName}-${cycle}`
      await client.request('createOrAttach', {
        sessionId,
        cols: 80,
        rows: 24,
        shellOverride: shellForPlatform(),
        shellReadySupported: false,
        cancelAfterMs: RPC_TIMEOUT_MS - 100
      })
      if (command) {
        await client.request('write', { sessionId, data: `${command}\r` })
        // Churn must be proven, not assumed: wait until the daemon actually
        // streamed the requested output back (echo + payload), bounded.
        const outputDeadline = Date.now() + 5000
        while (
          (outputCharsBySession.get(sessionId) ?? 0) < args.outputBytes &&
          Date.now() < outputDeadline
        ) {
          await delay(10)
        }
        if ((outputCharsBySession.get(sessionId) ?? 0) >= args.outputBytes) {
          fullOutputCycles++
        } else {
          shortOutputCycles++
        }
        if (args.settleMs > 0) {
          await delay(args.settleMs)
        }
      }
      await client.request('kill', { sessionId, immediate: true })
      outputCharsBySession.delete(sessionId)
      // Always sample the terminal cycle too: a cadence that does not divide
      // --cycles would otherwise drop the final measurement from the summary.
      if (cycle % args.sampleEvery === 0 || cycle === args.cycles) {
        await takeSample(cycle)
      }
    }
    if (command && shortOutputCycles > 0) {
      console.warn(
        `[bench] WARNING: ${shortOutputCycles}/${args.cycles} cycles did not reach ${args.outputBytes} output chars before the wait deadline`
      )
    }

    const listed = await client.request('listSessions', undefined)
    const liveSessions = listed?.sessions?.length ?? null

    // Leak-vs-retention discriminator for the natural series: one labelled
    // forced-GC sample AFTER the run, once every session is dead.
    let postRunForcedGc = null
    if (!forceGcBeforeSample) {
      await delay(500)
      await inspector.send('HeapProfiler.collectGarbage')
      await delay(250)
      const memory = await inspector.evaluateJson('process.memoryUsage()')
      postRunForcedGc = memorySample(
        `${seriesName}-post-run-forced-gc`,
        true,
        args.cycles,
        startedAt,
        memory
      )
    }

    await client.request('shutdown', { killSessions: true }, 10_000).catch(() => {})
    return {
      samples,
      postRunForcedGc,
      liveSessions,
      fullOutputCycles,
      shortOutputCycles,
      durationMs: Date.now() - startedAt
    }
  } catch (error) {
    error.message = `${error.message}\ndaemon stderr tail:\n${stderrTail}`
    throw error
  } finally {
    inspector?.close()
    client.destroy()
    if (!childExited) {
      // Only the exact child we spawned — never a pattern or name kill.
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        delay(5000)
      ])
      if (!childExited) {
        child.kill('SIGKILL')
      }
    }
    rmSync(runDir, { recursive: true, force: true })
  }
}

function summarizeSeries(samples) {
  if (samples.length === 0) {
    return null
  }
  const first = samples[0]
  const last = samples.at(-1)
  const peak = samples.reduce((max, sample) => Math.max(max, sample.rssKb), 0)
  const half = samples[Math.floor(samples.length / 2)]
  return {
    firstRssKb: first.rssKb,
    lastRssKb: last.rssKb,
    peakRssKb: peak,
    rssGrowthKb: last.rssKb - first.rssKb,
    secondHalfRssGrowthKb: last.rssKb - half.rssKb,
    firstHeapUsedKb: first.heapUsedKb,
    lastHeapUsedKb: last.heapUsedKb,
    cycles: last.cycles,
    durationMs: last.elapsedMs
  }
}

async function main() {
  const args = parseArgs(process.argv)
  const provenance = assertDaemonBuildProvenance(repoRoot)
  const protocolVersion = readProtocolVersion()
  const results = { args, provenance, series: {} }

  if (args.series !== 'forced-gc') {
    console.log(`[bench] natural series: ${args.cycles} cycles, no forced GC…`)
    results.series.natural = await runSeries({
      seriesName: 'natural',
      args,
      protocolVersion,
      forceGcBeforeSample: false
    })
    console.log(
      `[bench] natural done in ${Math.round(results.series.natural.durationMs / 1000)}s: ` +
        `rss ${results.series.natural.samples[0].rssKb}KB → ${results.series.natural.samples.at(-1).rssKb}KB, ` +
        `post-run forced-GC rss ${results.series.natural.postRunForcedGc?.rssKb}KB`
    )
  }
  if (args.series !== 'natural') {
    console.log(`[bench] forced-gc series: ${args.cycles} cycles, GC before every sample…`)
    results.series.forcedGc = await runSeries({
      seriesName: 'forced-gc',
      args,
      protocolVersion,
      forceGcBeforeSample: true
    })
    console.log(
      `[bench] forced-gc done in ${Math.round(results.series.forcedGc.durationMs / 1000)}s: ` +
        `rss ${results.series.forcedGc.samples[0].rssKb}KB → ${results.series.forcedGc.samples.at(-1).rssKb}KB`
    )
  }

  results.summary = {
    natural: summarizeSeries(results.series.natural?.samples ?? []),
    forcedGc: summarizeSeries(results.series.forcedGc?.samples ?? []),
    naturalPostRunForcedGc: results.series.natural?.postRunForcedGc ?? null
  }

  const resultsDir = join(scriptDir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(resultsDir, `daemon-pty-churn-rss-${args.label}-${stamp}.json`)
  const serialized = JSON.stringify(results, null, 2)
  // Results get committed as evidence — strip host-identifying home paths.
  const homeEscaped = JSON.stringify(os.homedir()).slice(1, -1)
  writeFileSync(outPath, serialized.split(homeEscaped).join('~'))
  console.log(`\n[bench] results written to ${outPath}`)

  for (const [name, summary] of Object.entries(results.summary)) {
    if (summary && summary.firstRssKb !== undefined) {
      console.log(
        `| ${name} | rss ${summary.firstRssKb}→${summary.lastRssKb}KB (peak ${summary.peakRssKb}) | ` +
          `heapUsed ${summary.firstHeapUsedKb}→${summary.lastHeapUsedKb}KB | ` +
          `${summary.cycles} cycles / ${Math.round(summary.durationMs / 1000)}s |`
      )
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

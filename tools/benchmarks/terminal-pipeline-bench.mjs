#!/usr/bin/env node
/**
 * Cross-terminal pipeline benchmark. Run INSIDE the terminal under test
 * (Orca pane, iTerm2, Ghostty, Terminal.app, VS Code, ...) — it measures the
 * full byte path of whatever terminal hosts it: PTY -> (daemon/ptyHost ->
 * IPC ->) parser -> response.
 *
 * Metrics per run:
 *   1. dsr-idle        — DSR (ESC[6n) round-trip latency at rest. The reply is
 *                        produced only after the terminal's parser reaches the
 *                        query, so this tracks the input/echo pipeline without
 *                        needing OS-level keystroke injection.
 *   2. throughput      — wall time to stream each fixture, ended by a DSR
 *                        fence. The fence matters: xterm.js-class terminals
 *                        ingest at wire speed into an internal queue and parse
 *                        later, so socket drain alone would flatter them.
 *   3. dsr-under-load  — DSR latency sampled while a paced (default 1 MB/s)
 *                        agent-TUI stream plays. This is the "typing while an
 *                        agent floods output" complaint, quantified.
 *
 * Usage (run in EACH terminal being compared, same machine, on AC power):
 *   node tools/benchmarks/terminal-pipeline-bench.mjs --label m2max-2026-07-02
 *     [--size-mb 10] [--iterations 5] [--dsr-count 200] [--skip-load]
 *     [--fixtures ascii-log,cjk-emoji,agent-tui,styles-stress]
 *
 * Aggregate results from all terminals into one comparison table:
 *   node tools/benchmarks/terminal-pipeline-bench.mjs report [--label <filter>]
 *
 * Protocol notes: keep hands off the keyboard during a run (stdin is parsed
 * for DSR replies), use a comparable window size everywhere, avoid tmux/screen
 * (they proxy the queries and would be the thing measured). `styles-stress` is
 * deliberately pathological (every cell restyled); read it as a ceiling probe,
 * not a realistic workload. Complementary manual metric: Typometer for true
 * keypress->pixel latency — this probe stops at the parser reply.
 * Results: tools/benchmarks/results/terminal-pipeline-<label>-<timestamp>.json
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const scriptDir = import.meta.dirname
const resultsDir = resolve(scriptDir, 'results')

const ESC = '\x1b'
const DSR_QUERY = `${ESC}[6n`
// oxlint-disable-next-line no-control-regex -- the ESC byte is the payload: this parses the terminal's cursor-position reply
const DSR_REPLY_RE = /\x1b\[(\d+);(\d+)R/
const CHUNK_BYTES = 64 * 1024
// Overridable: a dev-mode Electron terminal can hold >15s of parse backlog at
// a fence, which is a measurement (slow), not a hang — don't die on it.
let dsrTimeoutMs = 15_000

function parseArgs(argv) {
  const args = {
    mode: 'run',
    label: 'run',
    sizeMb: 10,
    iterations: 5,
    dsrCount: 200,
    skipLoad: false,
    forceNonTty: false,
    fixtures: ['ascii-log', 'cjk-emoji', 'agent-tui', 'styles-stress']
  }
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i]
    switch (argv[i]) {
      case 'report':
        args.mode = 'report'
        break
      case '--label':
        args.label = next()
        break
      case '--size-mb':
        args.sizeMb = Number(next())
        break
      case '--iterations':
        args.iterations = Number(next())
        break
      case '--dsr-count':
        args.dsrCount = Number(next())
        break
      case '--fixtures':
        args.fixtures = next().split(',')
        break
      case '--dsr-timeout-ms':
        dsrTimeoutMs = Number(next())
        break
      case '--skip-load':
        args.skipLoad = true
        break
      // For CI smoke tests of the script itself; numbers from a pipe are
      // meaningless because there is no terminal parsing them.
      case '--force-non-tty':
        args.forceNonTty = true
        break
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  if (!Number.isFinite(args.sizeMb) || args.sizeMb <= 0) {
    throw new Error('--size-mb must be > 0')
  }
  if (!Number.isInteger(args.iterations) || args.iterations <= 0) {
    throw new Error('--iterations must be a positive integer')
  }
  return args
}

// Deterministic PRNG so every terminal parses byte-identical fixtures.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)]
}

const LOG_WORDS =
  'build compile transform resolve bundle emit chunk module dependency vite electron terminal daemon renderer checkpoint snapshot worktree agent session'.split(
    ' '
  )

function asciiLogFixture(targetBytes) {
  const rng = mulberry32(1)
  const colors = ['32', '33', '36', '90', '35']
  const parts = []
  let bytes = 0
  let line = 0
  while (bytes < targetBytes) {
    line++
    const words = Array.from({ length: 6 + Math.floor(rng() * 8) }, () => pick(rng, LOG_WORDS))
    const s = `${ESC}[${pick(rng, colors)}m[build ${String(line).padStart(6, '0')}]${ESC}[0m ${words.join(' ')} (${Math.floor(rng() * 5000)}ms)\r\n`
    parts.push(s)
    bytes += s.length // fixture is ASCII + escapes: length === bytes
  }
  return parts.join('')
}

function cjkEmojiFixture(targetBytes) {
  const rng = mulberry32(2)
  const cjk = '終端の性能を測定する漢字混じりの長い行を生成します電光石火'
  const emoji = ['🚀', '🐋', '✅', '⚠️', '👨‍👩‍👧‍👦', '🇯🇵']
  const parts = []
  let bytes = 0
  let line = 0
  while (bytes < targetBytes) {
    line++
    const body = Array.from(
      { length: 8 + Math.floor(rng() * 10) },
      () => cjk[Math.floor(rng() * cjk.length)]
    ).join('')
    const s = `${String(line).padStart(6, '0')} ${body} ${pick(rng, emoji)}\r\n`
    parts.push(s)
    bytes += Buffer.byteLength(s, 'utf8')
  }
  return parts.join('')
}

// Claude-Code-shaped workload: transcript lines scroll into scrollback while a
// status block at the bottom repaints in place inside DEC 2026 synchronized
// frames. This is the mix behind the "scrolling in Claude Code is slow"
// complaint — NOT an alt-screen TUI.
function agentTuiFixture(targetBytes, cols, rows) {
  const rng = mulberry32(3)
  const statusRows = Math.min(10, Math.max(4, rows - 4))
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴']
  const parts = []
  let bytes = 0
  let frame = 0
  let painted = false
  const push = (s) => {
    parts.push(s)
    bytes += Buffer.byteLength(s, 'utf8')
  }
  while (bytes < targetBytes) {
    frame++
    push(`${ESC}[?2026h`)
    if (painted) {
      // Erase the previous status block, letting transcript lines above it
      // stand — mirrors how agent CLIs rewrite their bottom UI.
      push(`${ESC}[${statusRows}A${ESC}[0J`)
    }
    for (let t = 0; t < 2; t++) {
      const words = Array.from({ length: 8 }, () => pick(rng, LOG_WORDS))
      push(`${ESC}[2m●${ESC}[0m ${words.join(' ')}\r\n`)
    }
    for (let r = 0; r < statusRows; r++) {
      const fill = Math.floor(rng() * Math.max(10, cols - 20))
      push(
        `${ESC}[38;5;${33 + (r % 6)}m${pick(rng, spinner)} task ${frame % 100}·${r}${ESC}[0m ${'▇'.repeat(fill % 40)}\r\n`
      )
    }
    painted = true
    push(`${ESC}[?2026l`)
  }
  return parts.join('')
}

// Pathological ceiling probe: every cell gets its own SGR. Ghostty's
// maintainer explicitly calls this class of load unrepresentative; keep the
// label honest when reading results.
function stylesStressFixture(targetBytes, cols) {
  const rng = mulberry32(4)
  const parts = []
  let bytes = 0
  const push = (s) => {
    parts.push(s)
    bytes += s.length
  }
  while (bytes < targetBytes) {
    for (let c = 0; c < cols && bytes < targetBytes; c++) {
      push(`${ESC}[38;5;${Math.floor(rng() * 255)}mX`)
    }
    push(`${ESC}[0m\r\n`)
  }
  return parts.join('')
}

export function buildFixture(name, targetBytes, cols, rows) {
  switch (name) {
    case 'ascii-log':
      return asciiLogFixture(targetBytes)
    case 'cjk-emoji':
      return cjkEmojiFixture(targetBytes)
    case 'agent-tui':
      return agentTuiFixture(targetBytes, cols, rows)
    case 'styles-stress':
      return stylesStressFixture(targetBytes, cols)
    default:
      throw new Error(`Unknown fixture: ${name}`)
  }
}

// --- stdin DSR reply plumbing -------------------------------------------------

const dsrWaiters = []
let stdinBuffer = ''

function onStdinData(chunk) {
  stdinBuffer += chunk.toString('utf8')
  // Ctrl+C must still work while raw mode is on.
  if (stdinBuffer.includes('\x03')) {
    cleanupAndExit(130)
  }
  let match
  while (dsrWaiters.length > 0 && (match = DSR_REPLY_RE.exec(stdinBuffer))) {
    stdinBuffer = stdinBuffer.slice(match.index + match[0].length)
    dsrWaiters.shift().resolve(performance.now())
  }
  // Bound stray non-reply input (accidental keystrokes).
  if (stdinBuffer.length > 4096) {
    stdinBuffer = stdinBuffer.slice(-256)
  }
}

function dsrRoundTrip() {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      const idx = dsrWaiters.indexOf(waiter)
      if (idx !== -1) {
        dsrWaiters.splice(idx, 1)
      }
      reject(new Error('DSR reply timeout'))
    }, dsrTimeoutMs)
    const waiter = {
      resolve: (endTs) => {
        clearTimeout(timer)
        resolvePromise(endTs - startTs)
      }
    }
    dsrWaiters.push(waiter)
    const startTs = performance.now()
    process.stdout.write(DSR_QUERY)
  })
}

function writeChunk(data) {
  return new Promise((resolvePromise) => {
    if (process.stdout.write(data)) {
      resolvePromise()
    } else {
      process.stdout.once('drain', resolvePromise)
    }
  })
}

async function streamFixture(fixture) {
  for (let i = 0; i < fixture.length; i += CHUNK_BYTES) {
    await writeChunk(fixture.slice(i, i + CHUNK_BYTES))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function stats(samples) {
  if (samples.length === 0) {
    return null
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    count: sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted.at(-1)
  }
}

// --- benchmark phases ---------------------------------------------------------

async function measureDsrIdle(count) {
  const samples = []
  let timeouts = 0
  for (let i = 0; i < count; i++) {
    try {
      samples.push(await dsrRoundTrip())
    } catch {
      timeouts++
    }
    await sleep(5)
  }
  return { ...stats(samples), timeouts }
}

async function measureThroughput(name, fixture, iterations) {
  const fixtureBytes = Buffer.byteLength(fixture, 'utf8')
  // Warmup pass primes glyph atlases / JIT so iteration 1 isn't an outlier.
  await streamFixture(fixture.slice(0, Math.min(fixture.length, 512 * 1024)))
  await dsrRoundTrip().catch(() => {})
  const runs = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await streamFixture(fixture)
    // Fence: the terminal can only answer after parsing everything above.
    await dsrRoundTrip()
    runs.push(performance.now() - start)
  }
  const mbPerSec = runs.map((ms) => fixtureBytes / 1024 / 1024 / (ms / 1000))
  return { fixture: name, fixtureBytes, wallMs: stats(runs), mbPerSec: stats(mbPerSec) }
}

async function measureDsrUnderLoad(fixture, paceBytesPerSec, sampleCount) {
  const samples = []
  let timeouts = 0
  let stop = false
  const paceChunk = Math.min(CHUNK_BYTES, Math.floor(paceBytesPerSec / 20))
  const producer = (async () => {
    let offset = 0
    while (!stop) {
      await writeChunk(fixture.slice(offset, offset + paceChunk))
      offset = (offset + paceChunk) % fixture.length
      await sleep(50) // paceChunk every 50ms ≈ paceBytesPerSec
    }
  })()
  for (let i = 0; i < sampleCount; i++) {
    try {
      samples.push(await dsrRoundTrip())
    } catch {
      timeouts++
    }
    await sleep(100)
  }
  stop = true
  await producer
  return { paceBytesPerSec, ...stats(samples), timeouts }
}

// --- terminal state hygiene ---------------------------------------------------

function restoreTerminal() {
  // SGR reset, cursor visible, leave synchronized mode; keeps the host pane
  // usable no matter where a run aborted.
  process.stdout.write(`${ESC}[0m${ESC}[?25h${ESC}[?2026l\r\n`)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  process.stdin.pause()
}

function cleanupAndExit(code) {
  restoreTerminal()
  process.exit(code)
}

// --- report mode ----------------------------------------------------------------

function fmt(n, digits = 1) {
  return n === null || n === undefined ? '—' : n.toFixed(digits)
}

function runReport(labelFilter) {
  let files = []
  try {
    files = readdirSync(resultsDir).filter((f) => f.startsWith('terminal-pipeline-'))
  } catch {
    /* no results dir yet */
  }
  const rows = []
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(resultsDir, f), 'utf8'))
      if (labelFilter && labelFilter !== 'run' && !r.label.includes(labelFilter)) {
        continue
      }
      rows.push(r)
    } catch {
      /* skip unreadable */
    }
  }
  if (rows.length === 0) {
    console.log('No results found. Run the benchmark in each terminal first.')
    return
  }
  rows.sort((a, b) => (a.terminal.program || '').localeCompare(b.terminal.program || ''))
  console.log(
    '\nterminal              | dsr idle p50/p90 (ms) | dsr load p50/p90 (ms) | ascii MB/s | cjk MB/s | tui MB/s | stress MB/s'
  )
  console.log('-'.repeat(120))
  for (const r of rows) {
    const t = `${r.terminal.program ?? r.terminal.term ?? '?'} ${r.terminal.version ?? ''}`.trim()
    const tp = (name) => {
      const e = r.throughput?.find((x) => x.fixture === name)
      // Smoke-mode (--force-non-tty) entries have no mbPerSec — show a dash.
      return e?.mbPerSec ? fmt(e.mbPerSec.p50) : '—'
    }
    console.log(
      `${t.padEnd(21)} | ${fmt(r.dsrIdle?.p50, 2)}/${fmt(r.dsrIdle?.p90, 2).padEnd(12)} | ${fmt(r.dsrUnderLoad?.p50, 2)}/${fmt(r.dsrUnderLoad?.p90, 2).padEnd(12)} | ${tp('ascii-log').padStart(10)} | ${tp('cjk-emoji').padStart(8)} | ${tp('agent-tui').padStart(8)} | ${tp('styles-stress').padStart(11)}`
    )
  }
  console.log(`\n${rows.length} result file(s) from ${resultsDir}`)
}

// --- main -----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv)
  if (args.mode === 'report') {
    runReport(args.label)
    return
  }

  const isTty = process.stdout.isTTY && process.stdin.isTTY
  if (!isTty && !args.forceNonTty) {
    console.error(
      'stdout/stdin is not a TTY — run this inside the terminal under test.\n' +
        '(--force-non-tty runs anyway for script smoke tests; numbers are meaningless.)'
    )
    process.exit(1)
  }

  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24
  const targetBytes = Math.floor(args.sizeMb * 1024 * 1024)

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  process.stdin.on('data', onStdinData)
  process.on('SIGINT', () => cleanupAndExit(130))
  process.on('SIGTERM', () => cleanupAndExit(143))

  const meta = {
    benchmark: 'terminal-pipeline',
    label: args.label,
    timestamp: new Date().toISOString(),
    terminal: {
      program: process.env.TERM_PROGRAM ?? null,
      version: process.env.TERM_PROGRAM_VERSION ?? null,
      term: process.env.TERM ?? null,
      cols,
      rows,
      tty: isTty
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      release: os.release(),
      node: process.version
    },
    config: { sizeMb: args.sizeMb, iterations: args.iterations, dsrCount: args.dsrCount }
  }

  console.log(
    `terminal-pipeline-bench: ${meta.terminal.program ?? meta.terminal.term} ${meta.terminal.version ?? ''} (${cols}x${rows})`
  )
  console.log('Hands off the keyboard until the summary prints.\n')

  const result = { ...meta }

  if (isTty) {
    process.stdout.write('Phase 1/3: DSR idle latency...\r\n')
    result.dsrIdle = await measureDsrIdle(args.dsrCount)
  } else {
    result.dsrIdle = null
  }

  process.stdout.write('Phase 2/3: throughput fixtures...\r\n')
  result.throughput = []
  for (const name of args.fixtures) {
    const fixture = buildFixture(name, targetBytes, cols, rows)
    if (isTty) {
      result.throughput.push(await measureThroughput(name, fixture, args.iterations))
    } else {
      // Smoke mode: exercise generation + streaming only.
      await streamFixture(fixture.slice(0, CHUNK_BYTES))
      result.throughput.push({ fixture: name, fixtureBytes: Buffer.byteLength(fixture, 'utf8') })
    }
    process.stdout.write(`${ESC}[0m\r\n[done: ${name}]\r\n`)
  }

  if (isTty && !args.skipLoad) {
    process.stdout.write('Phase 3/3: DSR latency under paced agent-TUI load...\r\n')
    const loadFixture = buildFixture('agent-tui', targetBytes, cols, rows)
    result.dsrUnderLoad = await measureDsrUnderLoad(loadFixture, 1024 * 1024, 50)
  } else {
    result.dsrUnderLoad = null
  }

  restoreTerminal()

  mkdirSync(resultsDir, { recursive: true })
  const stamp = meta.timestamp.replace(/[:.]/g, '-')
  const outPath = join(resultsDir, `terminal-pipeline-${args.label}-${stamp}.json`)
  writeFileSync(outPath, JSON.stringify(result, null, 2))

  console.log('\n=== Summary ===')
  if (result.dsrIdle) {
    console.log(
      `DSR idle:       p50 ${fmt(result.dsrIdle.p50, 2)}ms  p90 ${fmt(result.dsrIdle.p90, 2)}ms  p99 ${fmt(result.dsrIdle.p99, 2)}ms  (timeouts: ${result.dsrIdle.timeouts})`
    )
  }
  if (result.dsrUnderLoad) {
    console.log(
      `DSR under load: p50 ${fmt(result.dsrUnderLoad.p50, 2)}ms  p90 ${fmt(result.dsrUnderLoad.p90, 2)}ms  p99 ${fmt(result.dsrUnderLoad.p99, 2)}ms  (timeouts: ${result.dsrUnderLoad.timeouts})`
    )
  }
  for (const t of result.throughput) {
    if (t.mbPerSec) {
      console.log(
        `${t.fixture.padEnd(14)} p50 ${fmt(t.mbPerSec.p50)} MB/s  (wall p50 ${fmt(t.wallMs.p50, 0)}ms over ${(t.fixtureBytes / 1024 / 1024).toFixed(1)}MB)`
      )
    }
  }
  console.log(`\nSaved: ${outPath}`)
  console.log('Compare terminals: node tools/benchmarks/terminal-pipeline-bench.mjs report')
  process.exit(0)
}

// Why the guard: buildFixture is imported by sibling analysis scripts
// (headless parse decomposition); importing must not start a benchmark run.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) {
  main().catch((err) => {
    restoreTerminal()
    console.error(err)
    process.exit(1)
  })
}

// Generate paced PTY agent load and sidecar echo arrivals for terminal-multi-workspace-typing-latency.spec.ts.
// Split driver→PTY receipt from receipt→polled xterm-buffer detection.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Import fixture builders by absolute file URL because generated scripts run in disposable repos, including Windows.
const PIPELINE_BENCH_URL = pathToFileURL(
  path.resolve(__dirname, '..', 'tools', 'benchmarks', 'terminal-pipeline-bench.mjs')
).href

export function sustainedLoadReadyFilePath(
  directory: string,
  runId: string,
  paneIndex: number
): string {
  return path.join(directory, `.orca-mwt-load-ready-${runId}-${paneIndex}`)
}

export function typingProbeReadyMarker(runId: string): string {
  return `MWT_TYPING_READY_${runId}`
}

export function typingKeyMarkerPrefix(runId: string): string {
  return `MWT_KEY_${runId}_`
}

function sustainedAgentLoadScript(runId: string, readyFileDirectory: string): string {
  return `
import { writeFileSync, renameSync } from 'node:fs'
import { buildFixture } from ${JSON.stringify(PIPELINE_BENCH_URL)}

const paneIndex = Number(process.argv[2] ?? 0)
const rateKbps = Number(process.argv[3] ?? 256)
const durationS = Number(process.argv[4] ?? 60)
const metadataEnabled = process.argv[5] === '1'
const titleChangeMs = Number(process.argv[6] ?? 0)
const lifecycleMs = Number(process.argv[7] ?? 0)

const cols = process.stdout.columns ?? 80
const rows = process.stdout.rows ?? 24
// 2MB of deterministic Claude-Code-shaped frames, replayed in a loop.
const fixture = Buffer.from(buildFixture('agent-tui', 2 * 1024 * 1024, cols, rows))

const TICK_MS = 50
const chunkBytes = Math.max(4, Math.floor((rateKbps * 1024 * TICK_MS) / 1000))
const writeChunk = (data) =>
  new Promise((resolve) => {
    if (process.stdout.write(data)) {
      resolve()
    } else {
      process.stdout.once('drain', resolve)
    }
  })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Readiness signals via the filesystem, not the terminal buffer: with many
// panes the stream scrolls a READY marker out of the buffer's serialize
// window before the spec's sequential checks reach it.
writeFileSync(
  ${JSON.stringify(readyFileDirectory)} + '/.orca-mwt-load-ready-${runId}-' + paneIndex,
  String(Date.now())
)
process.stdout.write('${'MWT_LOAD_READY_'}${runId}_' + paneIndex + '\\r\\n')
const startedAt = Date.now()
const deadline = startedAt + durationS * 1000
let nextTitleAt = startedAt + paneIndex * 17 % 80
let nextStatusAt = startedAt + paneIndex * 37 % 250
let nextStreamAt = startedAt
let nextReportAt = startedAt
let titleFrames = 0
let statusFrames = 0
let streamBytes = 0
let offset = 0
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
while (Date.now() < deadline) {
  const now = Date.now()
  if (metadataEnabled && now >= nextTitleAt) {
    await writeChunk('\\x1b]0;' + spinner[titleFrames % spinner.length] + ' OpenCode' + (titleChangeMs > 0 ? ' task ' + Math.floor((now - startedAt) / titleChangeMs) : '') + '\\x07')
    titleFrames += 1
    nextTitleAt = now + 80
  }
  if (metadataEnabled && now >= nextStatusAt) {
    statusFrames += 1
    await writeChunk('\\x1b]9999;' + JSON.stringify({
      state: lifecycleMs > 0 && Math.floor((now - startedAt) / lifecycleMs) % 2 ? 'waiting' : 'working', agentType: 'opencode',
      prompt: 'Synthetic production-path typing workload',
      lastAssistantMessage: 'Benchmark pane ' + paneIndex + ' update ' + statusFrames
    }) + '\\x07')
    nextStatusAt = now + 250
  }
  if (now >= nextStreamAt) {
    let end = Math.min(offset + chunkBytes, fixture.length)
    // Keep OSC metadata between complete UTF-8 characters.
    while (end > offset && end < fixture.length && (fixture[end] & 0xc0) === 0x80) end -= 1
    const chunk = fixture.subarray(offset, end)
    await writeChunk(chunk)
    streamBytes += chunk.length
    offset = end % fixture.length
    nextStreamAt = now + TICK_MS
  }
  if (now >= nextReportAt) {
    const statsPath = ${JSON.stringify(readyFileDirectory)} + '/.orca-mwt-load-stats-${runId}-' + paneIndex
    writeFileSync(statsPath + '.tmp', JSON.stringify({ startedAt, sampledAt: now, streamBytes, titleFrames, statusFrames }))
    renameSync(statsPath + '.tmp', statsPath)
    nextReportAt = now + 5000
  }
  await sleep(Math.max(1, Math.min(nextStreamAt,
    metadataEnabled ? Math.min(nextTitleAt, nextStatusAt) : nextStreamAt) - Date.now()))
}
process.stdout.write('\\x1b[0m\\x1b[?2026l\\r\\nMWT_LOAD_DONE_${runId}_' + paneIndex + '\\r\\n')
`
}

function typingEchoProbeScript(runId: string, arrivalSidecarPath: string): string {
  return `
import { appendFileSync } from 'node:fs'

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
process.stdout.write('${'MWT_TYPING_READY_'}${runId}\\r\\n')
process.stdin.on('data', (chunk) => {
  // One arrival timestamp per chunk: coalesced keystrokes genuinely arrive
  // together at the pty, and that coalescing is part of what we measure.
  const atMs = Date.now()
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  for (const char of chunk) {
    if (char === '\\r' || char === '\\n') continue
    seq += 1
    appendFileSync(
      ${JSON.stringify(arrivalSidecarPath)},
      JSON.stringify({ seq, atMs, char }) + '\\n'
    )
    process.stdout.write('\\r\\x1b[2Kmwt prompt ' + seq + ': ' + char + ' ${'MWT_KEY_'}${runId}_' + seq + '\\r\\n')
  }
})
`
}

// Model Codex DEC 2026 frames with body and closing ?2026l in separate writes; the plain unwrapped echo cannot leave xterm’s latch open.
// frameRows controls repaint size; splitDelayMs controls the source-side open-latch interval.
function codexEchoProbeScript(
  runId: string,
  arrivalSidecarPath: string,
  frameRows: number,
  splitDelayMs: number
): string {
  return `
import { appendFileSync } from 'node:fs'

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
const rows = ${frameRows}
const splitDelayMs = ${splitDelayMs}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const write = (data) =>
  new Promise((resolve) => {
    if (process.stdout.write(data)) resolve()
    else process.stdout.once('drain', resolve)
  })
process.stdout.write('${'MWT_TYPING_READY_'}${runId}\\r\\n')
let queue = Promise.resolve()
process.stdin.on('data', (chunk) => {
  const atMs = Date.now()
  if (chunk.includes(interrupt)) process.exit(0)
  for (const char of chunk) {
    if (char === '\\r' || char === '\\n') continue
    seq += 1
    const mySeq = seq
    appendFileSync(
      ${JSON.stringify(arrivalSidecarPath)},
      JSON.stringify({ seq: mySeq, atMs, char }) + '\\n'
    )
    queue = queue.then(async () => {
      // Frame body: open the latch, repaint rows, but do NOT close yet.
      let body = '\\x1b[?2026h'
      for (let row = 1; row <= rows; row++) {
        body += '\\x1b[' + row + ';1H\\x1b[2Kcodex frame row ' + row + ' seq ' + mySeq
      }
      body +=
        '\\x1b[' + (rows + 1) + ';1H\\x1b[2Kmwt prompt ' +
        mySeq + ': ' + char + ' ${'MWT_KEY_'}${runId}_' + mySeq
      await write(body)
      if (splitDelayMs > 0) await sleep(splitDelayMs)
      await write('\\x1b[?2026l')
    })
  }
})
`
}

export function writeCodexEchoProbeScript(
  scriptPath: string,
  runId: string,
  arrivalSidecarPath: string,
  options: { frameRows: number; splitDelayMs: number }
): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(
    scriptPath,
    codexEchoProbeScript(runId, arrivalSidecarPath, options.frameRows, options.splitDelayMs)
  )
}

export function writeSustainedAgentLoadScript(
  scriptPath: string,
  runId: string,
  readyFileDirectory: string
): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  // Normalize baked-in Windows paths because generated scripts join with forward slashes.
  writeFileSync(
    scriptPath,
    sustainedAgentLoadScript(runId, readyFileDirectory.replaceAll('\\', '/'))
  )
}

export function writeTypingEchoProbeScript(
  scriptPath: string,
  runId: string,
  arrivalSidecarPath: string
): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, typingEchoProbeScript(runId, arrivalSidecarPath))
}

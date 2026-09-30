/**
 * Script generators for the multi-workspace sustained typing-latency bench
 * (terminal-multi-workspace-typing-latency.spec.ts):
 *
 * - a paced agent-TUI load generator that replays the deterministic pipeline
 *   bench fixture through a real PTY at a fixed byte rate, emulating a Claude
 *   Code-style agent streaming in another workspace, and
 * - a typing echo probe that records each character and its arrival time at
 *   the pty in sidecar JSONL, so a key's total latency decomposes into
 *   input-half (CDP keydown -> pty stdin) and echo-half (pty echo -> screen).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Why absolute file URL: the generated .mjs scripts run with the disposable
// test repo as cwd, so the fixture builder must be imported by absolute
// specifier (file URL keeps Windows drive-letter paths importable).
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

export function writeSustainedAgentLoadScript(
  scriptPath: string,
  runId: string,
  readyFileDirectory: string
): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  // Generated scripts concatenate with '/', which Node's fs accepts on all
  // platforms; normalize Windows backslashes out of the baked-in directory.
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

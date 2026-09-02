/**
 * Script generators for the multi-workspace sustained typing-latency bench
 * (terminal-multi-workspace-typing-latency.spec.ts):
 *
 * - a paced agent-TUI load generator that replays the deterministic pipeline
 *   bench fixture through a real PTY at a fixed byte rate, emulating a Claude
 *   Code-style agent streaming in another workspace, and
 * - a typing echo probe that timestamps each keystroke's arrival at the pty
 *   into a sidecar JSONL, so a key's total latency decomposes into
 *   input-half (CDP keydown -> pty stdin) and echo-half (pty echo -> screen).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Why absolute file URL: the generated .mjs scripts run with the disposable
// test repo as cwd, so the fixture builder must be imported by absolute
// specifier (file URL keeps Windows drive-letter paths importable).
const PIPELINE_BENCH_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'tools', 'benchmarks', 'terminal-pipeline-bench.mjs')
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
import { writeFileSync } from 'node:fs'
import { buildFixture } from ${JSON.stringify(PIPELINE_BENCH_URL)}

const paneIndex = Number(process.argv[2] ?? 0)
const rateKbps = Number(process.argv[3] ?? 256)
const durationS = Number(process.argv[4] ?? 60)

const cols = process.stdout.columns ?? 80
const rows = process.stdout.rows ?? 24
// 2MB of deterministic Claude-Code-shaped frames, replayed in a loop.
const fixture = buildFixture('agent-tui', 2 * 1024 * 1024, cols, rows)

const TICK_MS = 50
const chunkChars = Math.max(1, Math.floor((rateKbps * 1024 * TICK_MS) / 1000))
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
const deadline = Date.now() + durationS * 1000
let offset = 0
while (Date.now() < deadline) {
  await writeChunk(fixture.slice(offset, offset + chunkChars))
  offset = (offset + chunkChars) % fixture.length
  await sleep(TICK_MS)
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
      JSON.stringify({ seq, atMs }) + '\\n'
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

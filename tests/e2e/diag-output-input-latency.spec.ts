/**
 * DIAGNOSTIC repro (not a CI test): typing echo latency while a dense-SGR
 * log stream (Orca assistant command output shape) writes into the SAME
 * terminal. Uses the in-renderer echo probe.
 *
 * Run: npx playwright test tests/e2e/diag-output-input-latency.spec.ts \
 *   --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { focusActiveTerminalInput } from './artificial-opencode-pane-interactions'
import {
  collectCodexEchoLatencyReport,
  formatDistribution,
  installCodexEchoLatencyProbe,
  summarizeLatencies
} from './codex-composer-echo-latency-probe'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Every character carries its own SGR color — the "syntax-highlighted log"
// shape Orca assistant output takes when it streams colored code/diffs.
// DENSITY: chars per SGR span (1 = worst case; 10 = token-ish; 0 = plain).
const RAW_SGR_DENSITY = Number(process.env.DIAG_SGR_DENSITY ?? '1')
const SGR_DENSITY = Number.isFinite(RAW_SGR_DENSITY) ? Math.max(0, RAW_SGR_DENSITY) : 1
const SIDECAR_PATH = process.env.DIAG_SIDECAR_PATH ?? ''
const SGR_SCRIPT = `
import { appendFileSync } from 'node:fs'
const colors = [31, 32, 33, 34, 35, 36, 90, 91, 92, 93, 94, 95, 96, 38, 39, 49]
const density = ${SGR_DENSITY}
let n = 0
let buf = ''
const flush = () => { if (buf) { process.stdout.write(buf); buf = '' } }
process.stdout.write('DIAG_SGR_READY\\r\\n')
${SIDECAR_PATH ? `process.stdin.setEncoding('utf8')\nprocess.stdin.resume()\nprocess.stdin.on('data', (chunk) => {\n  appendFileSync(${JSON.stringify(SIDECAR_PATH)}, JSON.stringify({ atMs: Date.now(), chunk }) + '\\n')\n})` : ''}
const deadline = Date.now() + 90 * 1000
;(async () => {
  while (Date.now() < deadline) {
    n++
    // 120-cell line; one SGR span per 'density' cells
    let c = 0
    while (c < 120) {
      const code = colors[(n + c) % colors.length]
      const span = Math.max(1, density)
      buf += '\\x1b[' + code + 'm'
      for (let k = 0; k < span && c < 120; k++, c++) {
        buf += String.fromCharCode(97 + ((n + c) % 26))
      }
      buf += '\\x1b[0m'
    }
    buf += '\\x1b[1m ' + n + '\\x1b[0m\\r\\n'
    if (buf.length >= 64 * 1024) flush()
    if (n % 40 === 0) { flush(); await new Promise((r) => setTimeout(r, 50)) }
  }
  flush()
})()
`

// Same byte rate, plain text, zero SGR.
const TEXT_SCRIPT = `
let n = 0
let buf = ''
const flush = () => { if (buf) { process.stdout.write(buf); buf = '' } }
process.stdout.write('DIAG_TXT_READY\\r\\n')
const deadline = Date.now() + 90 * 1000
;(async () => {
  while (Date.now() < deadline) {
    n++
    for (let c = 0; c < 120; c++) {
      buf += String.fromCharCode(97 + ((n + c) % 26))
    }
    buf += ' ' + n + '\\r\\n'
    if (buf.length >= 64 * 1024) flush()
    if (n % 40 === 0) { flush(); await new Promise((r) => setTimeout(r, 50)) }
  }
  flush()
})()
`

const MODE = process.env.DIAG_OUTPUT_MODE ?? 'sgr'
const SCRIPT = MODE === 'text' ? TEXT_SCRIPT : MODE === 'none' ? null : SGR_SCRIPT

const DIAG_ENABLED = process.env.ORCA_DIAG === '1'

test('diag: typing echo under dense-SGR output in same pane', async ({
  orcaPage,
  testRepoPath
}) => {
  test.skip(!DIAG_ENABLED, 'Diagnostic-only: run via ORCA_DIAG=1')
  test.setTimeout(6 * 60 * 1000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await focusActiveTerminalInput(orcaPage)

  const runId = randomUUID().slice(0, 8)
  const scriptPath = path.join(testRepoPath, `.diag-sgr-${runId}.mjs`)
  const sidecarPath = process.env.DIAG_SIDECAR_PATH
    ? path.resolve(process.env.DIAG_SIDECAR_PATH)
    : path.join(testRepoPath, `.diag-arrivals-${runId}.jsonl`)
  if (SCRIPT) {
    writeFileSync(scriptPath, SCRIPT)
  }
  rmSync(sidecarPath, { force: true })

  const target = 'abcdefghijklmnopqrstuvwxyz'
  await installCodexEchoLatencyProbe(orcaPage, target)
  try {
    if (SCRIPT) {
      // Why forward slashes: Node accepts them on Windows, and cmd/PowerShell
      // do not unescape JSON-doubled backslashes.
      await sendToTerminal(orcaPage, ptyId, `node "${scriptPath.replace(/\\/g, '/')}"\r`)
      // Let the stream start flowing, then type — the realistic shape is
      // typing WHILE the agent streams, not after minutes of accumulated output.
      await orcaPage.waitForTimeout(500)
    } else {
      await orcaPage.waitForTimeout(1500)
    }
    // focus again: sending the command may have blurred the terminal input
    await focusActiveTerminalInput(orcaPage)

    const keydownPageMs: number[] = []
    const keydownAtMs: number[] = []
    for (const char of target) {
      keydownPageMs.push(await orcaPage.evaluate(() => performance.now()))
      keydownAtMs.push(Date.now())
      await orcaPage.keyboard.type(char)
      await orcaPage.waitForTimeout(250)
    }
    await orcaPage.waitForTimeout(1500)

    const report = await collectCodexEchoLatencyReport(orcaPage)
    const parseMs = report.samples.map((s) => s.keyToParseMs)
    const renderMs = report.samples
      .map((s) => s.keyToRenderMs)
      .filter((v): v is number => v !== null)
    // Decompose: pty arrival timestamps from the sidecar (wall clock) vs the
    // keydown wall clock captured in the typing loop -> input-half latency.
    const inputHalfMs: number[] = []
    try {
      const sidecar = readFileSync(sidecarPath, 'utf8')
      const atMs: number[] = []
      for (const line of sidecar.split('\n')) {
        if (!line.trim()) {
          continue
        }
        const entry = JSON.parse(line) as { atMs: number; chunk: string }
        for (const char of entry.chunk) {
          if (char >= 'a' && char <= 'z') {
            atMs.push(entry.atMs)
          }
        }
      }
      for (let index = 0; index < keydownAtMs.length; index++) {
        const arrival = atMs[index]
        if (arrival !== undefined) {
          inputHalfMs.push(arrival - keydownAtMs[index])
        }
      }
    } catch {
      /* sidecar may be absent in text/none modes */
    }
    const sched = await orcaPage.evaluate(() => {
      const dbg = (window as unknown as {
        __terminalOutputSchedulerDebug?: { snapshot: () => unknown }
      }).__terminalOutputSchedulerDebug
      return dbg ? dbg.snapshot() : null
    })
    const mainDel = await orcaPage.evaluate(() =>
      (window as unknown as { api: { pty: { getRendererDeliveryDebugSnapshot: () => unknown } } }).api.pty
        .getRendererDeliveryDebugSnapshot()
        .catch(() => null)
    )
    console.log(
      `[diag:${MODE}] keysObserved=${report.keysObserved} parseEvents=${report.parseEvents} renderEvents=${report.renderEvents}`
    )
    console.log(`[diag:${MODE}] keyToParse : ${formatDistribution('', summarizeLatencies(parseMs))}`)
    console.log(`[diag:${MODE}] keyToRender: ${formatDistribution('', summarizeLatencies(renderMs))}`)
    if (inputHalfMs.length > 0) {
      console.log(
        `[diag:${MODE}] inputHalf  : ${formatDistribution('', summarizeLatencies(inputHalfMs))}`
      )
    }
    if (MODE === 'sgr' && sched && typeof sched.lastEchoWriteAt === 'number' && sched.lastEchoWriteAt > 0) {
      const lastKeydown = keydownPageMs.at(-1)
      const writeDelay = sched.lastEchoWriteAt - lastKeydown
      console.log(`[diag:${MODE}] lastEchoWriteAt - lastKeydown = ${writeDelay.toFixed(1)}ms`)
    }
    console.log(`[diag:${MODE}] scheduler=${JSON.stringify(sched)}`)
    console.log(`[diag:${MODE}] mainDelivery=${JSON.stringify(mainDel)}`)
    console.log(
      `[diag:${MODE}] samples=${JSON.stringify(report.samples.map((s) => s.keyToParseMs.toFixed(0)).join(','))}`
    )
    expect(report.keysObserved).toBe(target.length)
  } finally {
    await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    if (SCRIPT) {
      rmSync(scriptPath, { force: true })
    }
    rmSync(sidecarPath, { force: true })
  }
})

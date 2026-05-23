/* eslint-disable max-lines -- Why: this diagnostic stress test keeps setup,
 * synthetic Codex scripts, renderer lag probing, and assertions together so the
 * reproduction can run as one isolated e2e scenario. */
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from './helpers/orca-app'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(raw)}`)
  }
  return parsed
}

const EXTRA_WORKTREE_COUNT = readPositiveIntegerEnv('ORCA_E2E_CODEX_LAG_WORKTREES', 36)
const BACKGROUND_CODEX_TERMINALS = readPositiveIntegerEnv(
  'ORCA_E2E_CODEX_LAG_BACKGROUND_TERMINALS',
  4
)
const BACKGROUND_OUTPUT_INTERVAL_MS = readPositiveIntegerEnv(
  'ORCA_E2E_CODEX_LAG_BACKGROUND_INTERVAL_MS',
  10
)
const BACKGROUND_OUTPUT_PAYLOAD_CHARS = readPositiveIntegerEnv(
  'ORCA_E2E_CODEX_LAG_BACKGROUND_PAYLOAD_CHARS',
  220
)
const KEY_LATENCY_SAMPLES =
  process.env.ORCA_E2E_CODEX_LAG_KEY_SAMPLES ?? 'abcdefghijklmnopqrstuvwxyz012345'
const BACKGROUND_MODE = process.env.ORCA_E2E_CODEX_LAG_BACKGROUND_MODE ?? 'synthetic'
if (BACKGROUND_MODE !== 'synthetic' && BACKGROUND_MODE !== 'real-codex') {
  throw new Error(
    `ORCA_E2E_CODEX_LAG_BACKGROUND_MODE must be "synthetic" or "real-codex", received ${JSON.stringify(
      BACKGROUND_MODE
    )}`
  )
}
const MAX_MEDIAN_KEY_LATENCY_MS = 250
const MAX_WORST_KEY_LATENCY_MS = 1_000
const MAX_RENDERER_FRAME_GAP_MS = 500

type LagProbeSnapshot = {
  maxRafGapMs: number
  rafGapsOver50Ms: number[]
  longTasks: { duration: number; startTime: number; name: string }[]
}

type TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  flushWriteCount: number
  scheduledDrainCount: number
  drainWrites: number[]
}

type StressWorktree = {
  id: string
  path: string
}

function interactivePromptScript(runId: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
process.stdout.write('\\x1b]0;Codex foreground typing benchmark\\x07')
process.stdout.write('TYPING_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  for (const char of chunk) {
    if (char === '\\r' || char === '\\n') continue
    seq += 1
    process.stdout.write('\\r\\x1b[2KCodex prompt ' + seq + ': ' + char + ' TYPING_KEY_${runId}_' + seq + '\\n')
  }
})
`
}

// Why: shard-level load can let the first ready line scroll out before
// Playwright polls, so the marker stays in repeated output too.
function backgroundCodexScript(runId: string, intervalMs: number, payloadChars: number): string {
  return `
const id = process.argv[2] ?? 'bg'
const readyMarker = 'BG_READY_${runId}_' + id
let seq = 0
process.stdout.write(readyMarker + '\\n')
const emit = () => {
  seq += 1
  const spinner = ['|','/','-','\\\\'][seq % 4]
  const state = seq % 40 === 0 ? 'waiting' : 'working'
  const payload = {
    state,
    prompt: 'stress prompt ' + id,
    agentType: 'codex',
    toolName: seq % 7 === 0 ? 'Shell' : 'Read',
    toolInput: 'background work item ' + seq,
    lastAssistantMessage: 'synthetic codex progress ' + seq
  }
  process.stdout.write('\\x1b]0;' + spinner + ' Codex ' + id + ' ' + seq + '\\x07')
  process.stdout.write('\\x1b]9999;' + JSON.stringify(payload) + '\\x07')
  process.stdout.write('\\r\\x1b[2K' + spinner + ' codex ' + id + ' thinking ' + seq + ' ' + readyMarker + ' ' + 'x'.repeat(${payloadChars}) + '\\n')
}
setTimeout(() => setInterval(emit, ${intervalMs}), 250)
`
}

function realCodexBackgroundScript(
  runId: string,
  intervalMs: number,
  payloadChars: number
): string {
  return `
import { spawn } from 'node:child_process'

const id = process.argv[2] ?? 'bg'
const readyMarker = 'BG_READY_${runId}_' + id
process.stdout.write(readyMarker + '\\n')

let seq = 0
const emit = () => {
  seq += 1
  const spinner = ['|','/','-','\\\\'][seq % 4]
  const payload = {
    state: 'working',
    prompt: 'real codex stress prompt ' + id,
    agentType: 'codex',
    toolName: 'Codex',
    toolInput: 'real background codex process heartbeat ' + seq,
    lastAssistantMessage: 'real codex process still active ' + seq
  }
  process.stdout.write('\\x1b]0;' + spinner + ' Real Codex ' + id + ' ' + seq + '\\x07')
  process.stdout.write('\\x1b]9999;' + JSON.stringify(payload) + '\\x07')
  process.stdout.write('\\r\\x1b[2K' + spinner + ' real codex ' + id + ' active ' + seq + ' ' + readyMarker + ' ' + 'x'.repeat(${payloadChars}) + '\\n')
}
const heartbeat = setInterval(emit, ${intervalMs})

const progressPrefix = 'ORCA_REAL_CODEX_PROGRESS_${runId}_' + id
const progressProgram =
  "let i=0; const t=setInterval(() => { i += 1; console.log('" +
  progressPrefix +
  " ' + i + ' ' + 'x'.repeat(180)); if (i >= 40) { clearInterval(t); } }, 250)"
const prompt = [
  'This is an Orca terminal performance test.',
  'Before your final answer, run this exact read-only shell command:',
  'node -e ' + JSON.stringify(progressProgram),
  'After the command finishes, answer exactly: ORCA_REAL_CODEX_DONE_${runId}_' + id
].join(' ')

const child = spawn(
  'codex',
  ['-a', 'never', 'exec', '--sandbox', 'read-only', '--ephemeral', '--json', prompt],
  {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env
  }
)

child.on('error', (error) => {
  clearInterval(heartbeat)
  console.error('BG_CODEX_ERROR_${runId}_' + id + ' ' + error.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  clearInterval(heartbeat)
  process.stdout.write(
    'BG_CODEX_EXIT_${runId}_' + id + ' ' + (code === null ? signal : code) + '\\n'
  )
  process.exit(code ?? 0)
})
`
}

async function focusActiveTerminalInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane to focus')
    }
    pane.terminal.focus()
    const textarea = pane.container.querySelector(
      '.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null
    if (!textarea) {
      throw new Error('Active terminal has no xterm helper textarea')
    }
    textarea.focus()
  })
}

async function installRendererLagProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as {
      __orcaTerminalLagProbe?: {
        maxRafGapMs: number
        rafGapsOver50Ms: number[]
        longTasks: { duration: number; startTime: number; name: string }[]
        stop: () => void
        snapshot: () => LagProbeSnapshot
      }
    }
    target.__orcaTerminalLagProbe?.stop()

    let stopped = false
    let lastRaf = performance.now()
    const rafGapsOver50Ms: number[] = []
    const longTasks: { duration: number; startTime: number; name: string }[] = []
    let maxRafGapMs = 0
    let observer: PerformanceObserver | null = null

    const tick = (): void => {
      if (stopped) {
        return
      }
      const now = performance.now()
      const gap = now - lastRaf
      lastRaf = now
      maxRafGapMs = Math.max(maxRafGapMs, gap)
      if (gap > 50) {
        rafGapsOver50Ms.push(gap)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({
              duration: entry.duration,
              startTime: entry.startTime,
              name: entry.name
            })
          }
        })
        observer.observe({ entryTypes: ['longtask'] })
      } catch {
        observer = null
      }
    }

    target.__orcaTerminalLagProbe = {
      get maxRafGapMs() {
        return maxRafGapMs
      },
      get rafGapsOver50Ms() {
        return rafGapsOver50Ms
      },
      get longTasks() {
        return longTasks
      },
      stop: () => {
        stopped = true
        observer?.disconnect()
      },
      snapshot: () => ({
        maxRafGapMs,
        rafGapsOver50Ms: [...rafGapsOver50Ms],
        longTasks: [...longTasks]
      })
    }
  })
}

async function readRendererLagProbe(page: Page): Promise<LagProbeSnapshot> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __orcaTerminalLagProbe?: { snapshot: () => LagProbeSnapshot }
      }
    ).__orcaTerminalLagProbe
    if (!probe) {
      throw new Error('Renderer lag probe was not installed')
    }
    return probe.snapshot()
  })
}

async function resetTerminalOutputSchedulerDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    const debugApi = (
      window as unknown as {
        __terminalOutputSchedulerDebug?: { reset: () => void }
      }
    ).__terminalOutputSchedulerDebug
    if (!debugApi) {
      throw new Error('Terminal output scheduler debug API was not exposed')
    }
    debugApi.reset()
  })
}

async function readTerminalOutputSchedulerDebug(
  page: Page
): Promise<TerminalOutputSchedulerDebugSnapshot> {
  return page.evaluate(() => {
    const debugApi = (
      window as unknown as {
        __terminalOutputSchedulerDebug?: {
          snapshot: () => TerminalOutputSchedulerDebugSnapshot
        }
      }
    ).__terminalOutputSchedulerDebug
    if (!debugApi) {
      throw new Error('Terminal output scheduler debug API was not exposed')
    }
    return debugApi.snapshot()
  })
}

async function waitForMarkerLatency(
  page: Page,
  marker: string,
  timeoutMs: number
): Promise<number> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if ((await getTerminalContent(page, 16_000)).includes(marker)) {
      return performance.now() - start
    }
    await page.waitForTimeout(5)
  }
  throw new Error(`Timed out waiting for terminal marker ${marker}`)
}

async function waitForShellCommandReady(
  page: Page,
  ptyId: string,
  markerPrefix: string
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const marker = `${markerPrefix}_${attempt}`
    await sendToTerminal(page, ptyId, `printf '${marker}\\n'\r`)
    try {
      await waitForTerminalOutput(page, marker, 3_000)
      return
    } catch {
      // Retry: a freshly spawned PTY can have an id before the login shell is
      // ready to accept its first command, especially when many worktrees
      // mount terminals in sequence.
    }
  }
  throw new Error(`Timed out waiting for shell command readiness at ${markerPrefix}`)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function createStressWorktrees(
  page: Page,
  count: number,
  runId: string
): Promise<StressWorktree[]> {
  return page.evaluate(
    async ({ count, runId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const activeWorktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === state.activeWorktreeId)
      if (!activeWorktree) {
        throw new Error('No active worktree available for stress setup')
      }
      const worktrees: StressWorktree[] = []
      for (let index = 0; index < count; index++) {
        const name = `e2e-lag-${runId.slice(0, 8)}-${index}`
        const result = await state.createWorktree(activeWorktree.repoId, name, undefined, 'skip')
        worktrees.push({ id: result.worktree.id, path: result.worktree.path })
      }
      await state.fetchWorktrees(activeWorktree.repoId)
      return worktrees
    },
    { count, runId }
  )
}

async function activateWorktreeTerminal(page: Page, worktreeId: string): Promise<string> {
  await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveWorktree(worktreeId)
    const existingTab = state.tabsByWorktree[worktreeId]?.[0]
    const tab = existingTab ?? state.createTab(worktreeId)
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
  }, worktreeId)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page, 30_000)
  await focusActiveTerminalInput(page)
  await page.waitForTimeout(250)
  return ptyId
}

test.describe('Terminal Codex lag stress', () => {
  test('foreground typing stays responsive with many worktrees and busy background codex panes', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)

    await waitForSessionReady(orcaPage)
    const foregroundWorktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    let foregroundPtyId = await waitForActivePanePtyId(orcaPage)

    const runId = randomUUID()
    const foregroundScriptPath = path.join(testRepoPath, `.orca-typing-stress-${runId}.mjs`)
    const backgroundScriptPath = path.join(testRepoPath, `.orca-bg-codex-stress-${runId}.mjs`)
    writeFileSync(foregroundScriptPath, interactivePromptScript(runId))
    writeFileSync(
      backgroundScriptPath,
      BACKGROUND_MODE === 'real-codex'
        ? realCodexBackgroundScript(
            runId,
            BACKGROUND_OUTPUT_INTERVAL_MS,
            BACKGROUND_OUTPUT_PAYLOAD_CHARS
          )
        : backgroundCodexScript(
            runId,
            BACKGROUND_OUTPUT_INTERVAL_MS,
            BACKGROUND_OUTPUT_PAYLOAD_CHARS
          )
    )

    const backgroundPtyIds: string[] = []
    const createdWorktreeIds: string[] = []
    let foregroundCommandSent = false
    try {
      const syntheticWorktrees = await createStressWorktrees(orcaPage, EXTRA_WORKTREE_COUNT, runId)
      createdWorktreeIds.push(...syntheticWorktrees.map((worktree) => worktree.id))
      testInfo.attachments.push({
        name: 'stress-worktrees',
        contentType: 'text/plain',
        body: Buffer.from(syntheticWorktrees.map((worktree) => worktree.path).join('\n'))
      })

      for (let index = 0; index < BACKGROUND_CODEX_TERMINALS; index++) {
        const ptyId = await activateWorktreeTerminal(orcaPage, syntheticWorktrees[index].id)
        backgroundPtyIds.push(ptyId)
        await waitForShellCommandReady(orcaPage, ptyId, `SHELL_READY_${runId}_bg_${index}`)
        await sendToTerminal(
          orcaPage,
          ptyId,
          `node ${JSON.stringify(backgroundScriptPath)} ${JSON.stringify(`bg-${index}`)}\r`
        )
        await waitForTerminalOutput(orcaPage, `BG_READY_${runId}_bg-${index}`, 30_000)
      }

      foregroundPtyId = await activateWorktreeTerminal(orcaPage, foregroundWorktreeId)
      await waitForShellCommandReady(orcaPage, foregroundPtyId, `SHELL_READY_${runId}_fg`)
      await sendToTerminal(
        orcaPage,
        foregroundPtyId,
        `node ${JSON.stringify(foregroundScriptPath)}\r`
      )
      foregroundCommandSent = true
      await waitForTerminalOutput(orcaPage, `TYPING_READY_${runId}`, 10_000)
      await installRendererLagProbe(orcaPage)
      await resetTerminalOutputSchedulerDebug(orcaPage)
      await focusActiveTerminalInput(orcaPage)

      const latencies: number[] = []
      for (const [index, char] of [...KEY_LATENCY_SAMPLES].entries()) {
        const seq = index + 1
        const marker = `TYPING_KEY_${runId}_${seq}`
        const start = performance.now()
        await orcaPage.keyboard.type(char)
        await waitForMarkerLatency(orcaPage, marker, MAX_WORST_KEY_LATENCY_MS)
        latencies.push(performance.now() - start)
      }

      const probe = await readRendererLagProbe(orcaPage)
      const schedulerDebug = await readTerminalOutputSchedulerDebug(orcaPage)
      const medianLatency = median(latencies)
      const worstLatency = Math.max(...latencies)
      const worstLongTask = Math.max(0, ...probe.longTasks.map((entry) => entry.duration))
      const worstRafGap = probe.maxRafGapMs

      const summary = `worktrees=${EXTRA_WORKTREE_COUNT} backgroundTerminals=${BACKGROUND_CODEX_TERMINALS} backgroundMode=${BACKGROUND_MODE} backgroundIntervalMs=${BACKGROUND_OUTPUT_INTERVAL_MS} backgroundPayloadChars=${BACKGROUND_OUTPUT_PAYLOAD_CHARS} median=${medianLatency.toFixed(1)}ms worst=${worstLatency.toFixed(
        1
      )}ms worstRafGap=${worstRafGap.toFixed(1)}ms worstLongTask=${worstLongTask.toFixed(
        1
      )}ms rafGapsOver50=${probe.rafGapsOver50Ms
        .map((value) => value.toFixed(1))
        .join(',')} scheduler=${JSON.stringify(schedulerDebug)} samples=${latencies
        .map((value) => value.toFixed(1))
        .join(',')}`
      testInfo.annotations.push({ type: 'terminal-codex-lag-stress', description: summary })
      console.log(`[terminal-codex-lag-stress] ${summary}`)

      expect(medianLatency).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
      expect(worstLatency).toBeLessThan(MAX_WORST_KEY_LATENCY_MS)
      expect(worstRafGap).toBeLessThan(MAX_RENDERER_FRAME_GAP_MS)
      expect(schedulerDebug.backgroundEnqueueCount).toBeGreaterThan(0)
      expect(schedulerDebug.backgroundWriteCount).toBeGreaterThan(0)
      expect(schedulerDebug.foregroundWriteCount).toBeGreaterThan(0)
    } finally {
      if (foregroundCommandSent) {
        await sendToTerminal(orcaPage, foregroundPtyId, '\x03').catch(() => undefined)
      }
      for (const ptyId of backgroundPtyIds) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(foregroundScriptPath, { force: true })
      rmSync(backgroundScriptPath, { force: true })
      if (createdWorktreeIds.length > 0) {
        await orcaPage
          .evaluate(async (worktreeIds) => {
            const store = window.__store
            if (!store) {
              return
            }
            for (const worktreeId of [...worktreeIds].reverse()) {
              try {
                await store.getState().removeWorktree(worktreeId, true)
              } catch {
                // best-effort cleanup
              }
            }
          }, createdWorktreeIds)
          .catch(() => undefined)
      }
    }
  })
})

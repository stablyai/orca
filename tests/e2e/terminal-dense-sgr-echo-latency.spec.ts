import type { Page } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'

type OutputMode = 'plain' | 'dense-sgr'

type EchoSample = {
  index: number
  latencyMs: number
}

type EchoProbeReport = {
  samples: EchoSample[]
  keysObserved: number
  parseEvents: number
}

type EchoProbeWindow = Window & {
  __denseSgrEchoProbe?: {
    report(): EchoProbeReport
    dispose(): void
  }
  __terminalOutputSchedulerDebug?: {
    reset(): void
    snapshot(): unknown
  }
}

const TYPED = 'abcdefghijklmnopqrstuvwxyz'
const KEY_INTERVAL_MS = 250
const ECHO_TIMEOUT_MS = Number(process.env.ORCA_DIAG_TIMEOUT_MS ?? 60_000)
const STYLED_CHARS_PER_TICK = Number(process.env.ORCA_DIAG_STYLED_CHARS ?? 80)

function outputFloodScript(runId: string, mode: OutputMode): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()

const runId = ${JSON.stringify(runId)}
const mode = ${JSON.stringify(mode)}
const interrupt = String.fromCharCode(3)
let dense = ''
for (let index = 0; index < ${STYLED_CHARS_PER_TICK}; index += 1) {
  dense += '\\x1b[38;5;' + (index % 216) + 'mX\\x1b[0m'
}
dense += '\\r\\n'
const chunk = mode === 'dense-sgr' ? dense : 'X'.repeat(dense.length - 2) + '\\r\\n'
let sequence = 0
let floodTimer

process.stdout.write('DENSE_SGR_READY_' + runId + '\\r\\n')
setTimeout(() => {
  floodTimer = setInterval(() => process.stdout.write(chunk), 1)
}, 2_000)

process.stdin.on('data', (data) => {
  if (data.includes(interrupt)) {
    clearInterval(floodTimer)
    process.exit(0)
  }
  for (const char of data) {
    if (char === '\\r' || char === '\\n') continue
    sequence += 1
    process.stdout.write('\\x1b[0m\\r\\n__ORCA_ECHO_' + runId + '_' + sequence + '__\\r\\n')
  }
})
`
}

async function installEchoProbe(page: Page, runId: string): Promise<void> {
  await page.evaluate(
    ({ runId, expectedKeys }) => {
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
      if (!pane || typeof pane.terminal.onWriteParsed !== 'function') {
        throw new Error('Dense-SGR echo probe requires an active xterm with onWriteParsed')
      }

      const terminal = pane.terminal
      const pending: { index: number; startedAt: number; marker: string }[] = []
      const samples: EchoSample[] = []
      const scheduledMarkers = new Set<string>()
      let keysObserved = 0
      let parseEvents = 0
      let writeTail = ''
      const originalWrite = terminal.write
      terminal.write = ((data: string, callback?: () => void) => {
        const searchable = writeTail + data
        const observed = pending.filter(
          ({ marker }) => !scheduledMarkers.has(marker) && searchable.includes(marker)
        )
        for (const { marker } of observed) {
          scheduledMarkers.add(marker)
        }
        writeTail = searchable.slice(-256)
        originalWrite.call(terminal, data, () => {
          const parsedAt = performance.now()
          for (const item of observed) {
            const pendingIndex = pending.findIndex(({ marker }) => marker === item.marker)
            if (pendingIndex < 0) {
              continue
            }
            pending.splice(pendingIndex, 1)
            samples.push({ index: item.index, latencyMs: parsedAt - item.startedAt })
          }
          callback?.()
        })
      }) as typeof terminal.write

      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key.length !== 1 || keysObserved >= expectedKeys) {
          return
        }
        const index = keysObserved
        keysObserved += 1
        pending.push({
          index,
          startedAt: performance.now(),
          marker: `__ORCA_ECHO_${runId}_${index + 1}__`
        })
      }

      const parsedDisposable = terminal.onWriteParsed(() => {
        parseEvents += 1
      })

      window.addEventListener('keydown', onKeyDown, { capture: true })
      const target = window as EchoProbeWindow
      target.__denseSgrEchoProbe = {
        report: () => ({ samples: [...samples], keysObserved, parseEvents }),
        dispose: () => {
          window.removeEventListener('keydown', onKeyDown, { capture: true })
          parsedDisposable.dispose()
          terminal.write = originalWrite
        }
      }
    },
    { runId, expectedKeys: TYPED.length }
  )
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] ?? 0
}

for (const mode of ['plain', 'dense-sgr'] as const) {
  test(`${mode} flood keydown-to-parse latency @diagnostic`, async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.skip(process.env.ORCA_DIAG !== '1', 'Set ORCA_DIAG=1 to run the latency diagnostic')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-dense-sgr-${runId}.mjs`)
    writeFileSync(scriptPath, outputFloodScript(runId, mode))

    try {
      await orcaPage.evaluate(async () => {
        await window.api.pty.resetRendererDeliveryDebug()
        ;(window as EchoProbeWindow).__terminalOutputSchedulerDebug?.reset()
      })
      await installEchoProbe(orcaPage, runId)
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await waitForTerminalOutput(orcaPage, `DENSE_SGR_READY_${runId}`, 10_000)
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.waitForTimeout(2_200)

      for (const char of TYPED) {
        await orcaPage.keyboard.type(char)
        await orcaPage.waitForTimeout(KEY_INTERVAL_MS)
      }
      await orcaPage.waitForTimeout(250)
      await sendToTerminal(orcaPage, ptyId, '\x03')

      let completionError: unknown
      try {
        await expect
          .poll(
            () =>
              orcaPage.evaluate(
                () => (window as EchoProbeWindow).__denseSgrEchoProbe?.report().samples.length ?? 0
              ),
            { timeout: ECHO_TIMEOUT_MS }
          )
          .toBe(TYPED.length)
      } catch (error) {
        completionError = error
      }

      const result = await orcaPage.evaluate(async () => {
        const probe = (window as EchoProbeWindow).__denseSgrEchoProbe
        if (!probe) {
          throw new Error('Dense-SGR echo probe was not installed')
        }
        const report = probe.report()
        probe.dispose()
        return {
          report,
          scheduler: (window as EchoProbeWindow).__terminalOutputSchedulerDebug?.snapshot() ?? null,
          main: await window.api.pty.getRendererDeliveryDebugSnapshot()
        }
      })
      const latencies = result.report.samples.map((sample) => sample.latencyMs)
      const observedIndexes = new Set(result.report.samples.map((sample) => sample.index))
      const missingIndexes = [...TYPED].flatMap((_char, index) =>
        observedIndexes.has(index) ? [] : [index]
      )
      const summary =
        `mode=${mode} p50=${percentile(latencies, 0.5).toFixed(1)}ms ` +
        `p95=${percentile(latencies, 0.95).toFixed(1)}ms max=${Math.max(...latencies).toFixed(1)}ms ` +
        `samples=${latencies.length} missing=${missingIndexes.join(',') || 'none'}`
      console.log(`[dense-sgr-echo] ${summary}`)
      const scheduler = result.scheduler as
        | (Record<string, unknown> & { drainWrites?: number[] })
        | null
      const schedulerSummary = scheduler
        ? {
            ...scheduler,
            drainWrites: undefined,
            drainCount: scheduler.drainWrites?.length ?? 0,
            maxWritesPerDrain: Math.max(0, ...(scheduler.drainWrites ?? []))
          }
        : null
      console.log(`[dense-sgr-echo] scheduler=${JSON.stringify(schedulerSummary)}`)
      console.log(`[dense-sgr-echo] main=${JSON.stringify(result.main)}`)
      testInfo.annotations.push({ type: 'dense-sgr-echo-latency', description: summary })
      if (completionError) {
        throw completionError
      }
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      rmSync(scriptPath, { force: true })
    }
  })
}

import { randomUUID } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  sendToTerminal
} from './helpers/terminal'
import {
  KEY_LATENCY_SAMPLES,
  MAX_MEDIAN_KEY_LATENCY_MS,
  MAX_WORST_KEY_LATENCY_MS,
  interactivePromptScript,
  waitForMarkerLatency,
  median
} from './helpers/terminal-typing-benchmark'
import { makeResourceManagerFixtureVisible } from './helpers/resource-manager-visible-fixture'

type PtyInputCounts = { listing: number; metrics: number }

declare global {
  var __ptyInputCounts: PtyInputCounts | undefined
}

test('terminal input stays responsive with a slow 1,000-session inventory, and hidden open PTYs stop scanning', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const id = await waitForActivePanePtyId(orcaPage)
  const runId = randomUUID()
  const script = join(testRepoPath, `.orca-resource-input-${runId}.mjs`)
  writeFileSync(script, interactivePromptScript(runId))
  const measurements: { state: string; medianMs: number; worstMs: number }[] = []
  let sequence = 0
  try {
    await sendToTerminal(orcaPage, id, `node ${JSON.stringify(script)}\r`)
    await waitForTerminalOutput(orcaPage, `TYPING_READY_${runId}`, 10_000)
    await electronApp.evaluate(({ ipcMain }) => {
      const counts: PtyInputCounts = { listing: 0, metrics: 0 }
      globalThis.__ptyInputCounts = counts
      ipcMain.removeHandler('pty:listSessions')
      ipcMain.handle('pty:listSessions', async (_event, scope) => {
        counts.listing++
        await new Promise((resolve) => setTimeout(resolve, 150))
        return scope?.connectionId === null
          ? Array.from({ length: 1_000 }, (_, index) => ({
              id: `fixture-${index}`,
              incarnationId: `inc-${index}`,
              title: `Terminal ${index}`,
              cwd: '/fixture',
              agentOwnership: 'unknown',
              fencedTermination: false
            }))
          : []
      })
      ipcMain.removeHandler('memory:getSnapshot')
      ipcMain.handle('memory:getSnapshot', () => {
        counts.metrics++
        return null
      })
    })
    await makeResourceManagerFixtureVisible(electronApp, orcaPage)
    for (const state of ['closed', 'visible-active', 'hidden-open'] as const) {
      if (state === 'visible-active') {
        await orcaPage.getByRole('button', { name: /^Resource Manager,/ }).click()
        await orcaPage.getByRole('tab', { name: 'PTYs', exact: true }).click()
      }
      if (state === 'hidden-open') {
        await electronApp.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('memory:resourceWindowVisibility', false)
          }
        })
      }
      await focusActiveTerminalInput(orcaPage)
      const latencies: number[] = []
      const before = await electronApp.evaluate(() => {
        if (!globalThis.__ptyInputCounts) {
          throw new Error('PTY input counters missing')
        }
        return globalThis.__ptyInputCounts
      })
      for (const char of KEY_LATENCY_SAMPLES) {
        const start = performance.now()
        await orcaPage.keyboard.type(char)
        await waitForMarkerLatency(
          orcaPage,
          `TYPING_KEY_${runId}_${++sequence}`,
          MAX_WORST_KEY_LATENCY_MS
        )
        latencies.push(performance.now() - start)
      }
      const result = { state, medianMs: median(latencies), worstMs: Math.max(...latencies) }
      measurements.push(result)
      expect(result.medianMs).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
      expect(result.worstMs).toBeLessThan(MAX_WORST_KEY_LATENCY_MS)
      if (state === 'visible-active') {
        await expect(
          orcaPage.getByText('1000 Orca PTYs on this computer · 1000 without a tab', {
            exact: true
          })
        ).toBeVisible()
      }
      if (state === 'hidden-open') {
        await orcaPage.waitForTimeout(2_100)
        expect(
          await electronApp.evaluate(() => {
            if (!globalThis.__ptyInputCounts) {
              throw new Error('PTY input counters missing')
            }
            return globalThis.__ptyInputCounts
          })
        ).toEqual(before)
        await expect(orcaPage.getByRole('tab', { name: 'PTYs 1000', exact: true })).toBeVisible()
      }
    }
    console.info(JSON.stringify({ terminalInput: measurements }))
    await testInfo.attach('resource-terminal-input', {
      body: JSON.stringify(measurements),
      contentType: 'application/json'
    })
  } finally {
    await sendToTerminal(orcaPage, id, '\x03').catch(() => {})
    rmSync(script, { force: true })
  }
})

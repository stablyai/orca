// #2836: force renderer death/recovery, then discriminate frozen input between xterm transport and PTY routing.
// Drive recovery from main because renderer crash severs Playwright’s CDP session even after the app reloads.

import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  discoverActivePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import {
  buildFrozenPaneReport,
  mainGetAllTerminalContent,
  mainGetStorePtyIds,
  mainProbeDirectWrite,
  mainProbeOwnershipRebuildRevival,
  mainProbeTransportPaste,
  mainRendererStoreReady,
  mainWaitForPaneMounted,
  probeKeyboardType
} from './helpers/terminal-input-probes'

// Use two crashes: the third risks tripping the three-per-minute recovery circuit breaker.
const CRASH_CYCLES = 2

// Recovery = 250ms reload timer + full document reload + session hydration.
const RECOVERY_TIMEOUT_MS = 60_000

type CrashProbe = {
  processGone: { reason: string; exitCode: number } | null
  recoveredLoads: number
}

declare global {
  var __crashProbe: CrashProbe | undefined
}

// Re-arm per-cycle main-process lifecycle probes; old listeners retain only superseded probe objects.
async function armMainProcessCrashProbe(electronApp: ElectronApplication): Promise<void> {
  // Safe to repeat: re-arming supersedes the probe a collected attempt may have installed.
  await retryTransientMainEvaluate(() =>
    electronApp.evaluate(({ BrowserWindow }) => {
      const probe: CrashProbe = { processGone: null, recoveredLoads: 0 }
      globalThis.__crashProbe = probe
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.on('render-process-gone', (_event, details) => {
          probe.processGone = { reason: details.reason, exitCode: details.exitCode ?? -1 }
        })
        win.webContents.on('did-finish-load', () => {
          probe.recoveredLoads += 1
        })
      }
    })
  )
}

async function readMainProcessCrashProbe(electronApp: ElectronApplication): Promise<CrashProbe> {
  // Why: expect.poll does not retry a thrown read, and Electron's main evaluate can be collected spuriously.
  return retryTransientMainEvaluate(() =>
    electronApp.evaluate(() => globalThis.__crashProbe ?? { processGone: null, recoveredLoads: 0 })
  )
}

async function waitForRendererRecovery(electronApp: ElectronApplication): Promise<void> {
  await expect
    .poll(async () => (await readMainProcessCrashProbe(electronApp)).recoveredLoads, {
      timeout: RECOVERY_TIMEOUT_MS,
      message:
        'Main process never observed a recovery reload (did-finish-load) after the forced crash — scheduleRendererRecovery did not fire'
    })
    .toBeGreaterThan(0)
  await expect
    .poll(async () => mainRendererStoreReady(electronApp), {
      timeout: RECOVERY_TIMEOUT_MS,
      message: 'Recovered renderer never reached workspaceSessionReady'
    })
    .toBe(true)
  await mainWaitForPaneMounted(electronApp)
}

test.describe('Renderer crash recovery keeps terminal input alive', () => {
  test('typing still reaches the PTY after forced renderer crash + auto-reload', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(300_000)

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)

    // Prove DOM keyboard and PTY roundtrip before crash so recovery failures are interpretable.
    const baselinePtyId = await discoverActivePtyId(orcaPage)
    expect(
      await probeKeyboardType(orcaPage, 'KB_BASELINE_OK'),
      'baseline keyboard input must reach the PTY before any crash is forced'
    ).toBe(true)

    for (let cycle = 0; cycle < CRASH_CYCLES; cycle++) {
      await armMainProcessCrashProbe(electronApp)
      await electronApp.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.forcefullyCrashRenderer()
        }
      })

      await expect
        .poll(async () => (await readMainProcessCrashProbe(electronApp)).processGone?.reason, {
          timeout: 15_000,
          message: 'forcefullyCrashRenderer never produced a render-process-gone event'
        })
        .toBeTruthy()

      await waitForRendererRecovery(electronApp)

      // Require reattach to the daemon session that survives renderer death.
      const postPtyIds = await mainGetStorePtyIds(electronApp)

      // Poll through async transport recovery; a single write can race the temporary unbound interval.
      let transportAlive = false
      try {
        await expect
          .poll(
            async () => {
              transportAlive = await mainProbeTransportPaste(
                electronApp,
                `PASTE_POST_${cycle}_OK`,
                5_000
              )
              return transportAlive
            },
            { timeout: RECOVERY_TIMEOUT_MS }
          )
          .toBe(true)
      } catch {
        transportAlive = false
      }
      const directAlive =
        postPtyIds.length > 0 &&
        (await mainProbeDirectWrite(electronApp, postPtyIds[0], `DIRECT_POST_${cycle}_OK`))

      if (!transportAlive || !directAlive) {
        const revived =
          postPtyIds.length > 0 &&
          (await mainProbeOwnershipRebuildRevival(
            electronApp,
            postPtyIds[0],
            `REVIVED_POST_${cycle}_OK`
          ))
        const crashReason =
          (await readMainProcessCrashProbe(electronApp)).processGone?.reason ?? 'unknown'
        throw new Error(
          buildFrozenPaneReport(
            `crash cycle ${cycle}, baseline ptyId ${baselinePtyId}, crash reason ${crashReason}`,
            {
              directAlive,
              transportAlive,
              revivedByOwnershipRebuild: revived,
              ptyIds: postPtyIds,
              terminalTail: await mainGetAllTerminalContent(electronApp)
            }
          )
        )
      }
    }
  })
})

/**
 * Repro spec for the frozen-terminal-after-renderer-recovery report
 * (Discord #performance, GitHub #2836 family).
 *
 * Field evidence: pane shows content, shell is alive, daemon output.log does
 * not grow while typing — i.e. keystrokes silently vanish somewhere between
 * xterm and the PTY. This spec forces the suspected trigger — renderer
 * process death followed by the automatic recovery reload
 * (createMainWindow.ts scheduleRendererRecovery) — then discriminates which
 * layer drops input via the probes in helpers/terminal-input-probes.ts.
 *
 * Post-crash phases are driven from the MAIN process: a crashed target
 * severs Playwright's CDP session even though the app recovers, so page.*
 * calls can never observe the recovered renderer (verified empirically —
 * main saw did-finish-load while every window handle stayed dead).
 */

import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
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

// Why 2, not more: the renderer recovery circuit breaker allows 3 recoveries
// per 60s window (DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES); a third forced
// crash risks tripping it and testing the breaker instead of the reattach.
const CRASH_CYCLES = 2

// Recovery = 250ms reload timer + full document reload + session hydration.
const RECOVERY_TIMEOUT_MS = 60_000

type CrashProbe = {
  processGone: { reason: string; exitCode: number } | null
  recoveredLoads: number
}

declare global {
  // eslint-disable-next-line no-var -- main-process global probe for this spec
  var __crashProbe: CrashProbe | undefined
}

/**
 * Observe the crash/recovery lifecycle from the MAIN process. Re-arming
 * replaces the probe object, so counts reset per cycle; stale listeners from
 * a previous arm write only to their own superseded probe object.
 */
async function armMainProcessCrashProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
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
}

async function readMainProcessCrashProbe(electronApp: ElectronApplication): Promise<CrashProbe> {
  return electronApp.evaluate(
    () => globalThis.__crashProbe ?? { processGone: null, recoveredLoads: 0 }
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

    // Baseline: both the DOM keyboard layer (Playwright-driven, only possible
    // pre-crash) and the PTY roundtrip must work before we crash anything,
    // otherwise a post-crash failure would be uninterpretable.
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

      // Daemon-backed sessions survive renderer death by design, so the pane
      // should reattach to the same session rather than spawn a fresh shell.
      const postPtyIds = await mainGetStorePtyIds(electronApp)

      const transportAlive = await mainProbeTransportPaste(electronApp, `PASTE_POST_${cycle}_OK`)
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

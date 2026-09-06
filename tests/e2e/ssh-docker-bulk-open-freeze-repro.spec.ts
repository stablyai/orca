/**
 * Freeze repro R2 — direct SSH topology via Docker SSH relay.
 *
 * Requires: ORCA_E2E_SSH_DOCKER=1 and Docker available.
 *
 * Run:
 *   ORCA_E2E_SSH_DOCKER=1 pnpm run test:e2e:ssh-docker-bulk-open-freeze
 */
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  focusLastTerminalPane,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { startRendererLagProbe } from './paired-runtime-retention-metrics'
import { HARD_FREEZE_LAG_MS, SOFT_FREEZE_LAG_MS } from './helpers/remote-session-bulk-open-oracle'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const REPORT_DIR = path.join(process.cwd(), 'test-results', 'freeze-repro')
const SESSION_SPLITS = 5
const FLOOD_READ_CHARS = 80_000

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function continuousFloodCommand(runId: string, index: number): string {
  // Node one-liner: continuous 2KB frames @ ~8ms like agent output.
  const script = [
    `const id='SSH_BULK_${runId}_${index}'`,
    "process.stdout.write('READY:'+id+'\\n')",
    'let f=0',
    "const c='S'.repeat(2048)",
    "setInterval(()=>{f++;process.stdout.write('BG:'+id+':'+f+':'+c+'\\n')},8)",
    'process.stdin.resume()'
  ].join(';')
  return `node -e ${shellQuote(script)}`
}

test.describe('R2 Docker SSH bulk-open freeze', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker SSH freeze repro')

  // Fixme: un-rotted and measurable, but its oracle is wall-clock and does not survive a change of
  // host, so it cannot gate. Three runs of the same measurement path:
  //
  //   host                    hiddenFlood   bulkOpen   interaction
  //   developer workstation         2.1ms     41.5ms        53.6ms
  //   GitHub ubuntu runner A        1.5ms   2575.6ms      3464.2ms
  //   GitHub ubuntu runner B        0.2ms    397.4ms      3386.7ms
  //
  // Two separate problems, and neither is the product. `bulkOpenMaxLagMs` swings 6.5x between two
  // CI runs of the same code, so a fixed threshold on it is a coin flip; `interactionProbeMs` sits
  // stably ~64x over the workstation figure, because it times two `setActiveView` round trips
  // through a double rAF — a view remount cost, not the renderer freeze #16764 reports. It shares
  // SOFT/HARD_FREEZE_LAG_MS with the lag probe only because both are milliseconds. `hardFreeze`
  // has never tripped on any host; the failure is always the soft budget.
  //
  // Not converted to a ratio against a calibration run: with a 6.5x within-host swing on the very
  // quantity that would be normalized, a threshold picked from three samples is the same arbitrary
  // constant in dimensionless clothing. Gating needs a distribution first.
  //
  // Kept executable rather than deleted: flip `test.fixme` back to `test` to run it, which is how
  // the numbers above were taken. Tracked in stablyai/orca#16764.
  //
  // The cost is real and is recorded in run-ssh-docker-e2e.mjs: 5 simultaneously flooding SSH panes
  // exercise writer saturation, ACK/credit accounting and per-pane polling together, and nothing
  // else covers that combination. It is a gap, not coverage living somewhere else.
  test.fixme('bulk-open many flooding SSH terminals and measure renderer lag @freeze-repro', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.setTimeout(420_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      registerPostElectronShutdownCleanup(async () => {
        if (target) {
          cleanupDockerSshRelayTarget(target)
        }
      })

      // Why: session restore must settle before the remote worktree is added, or the
      // seeded terminal tab races tab hydration and never binds to the remote PTY.
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await connectDockerSshRelayTarget(orcaPage, target, {
        remotePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
      })

      const runId = `${Date.now()}`
      // First terminal on the SSH worktree.
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const firstPtyId = await waitForActivePanePtyId(orcaPage, 60_000)
      await execInTerminal(orcaPage, firstPtyId, continuousFloodCommand(runId, 0))
      // Why: the one-shot READY line is buried by the 2KB/8ms flood within ~16ms, so it is
      // unobservable through the terminal read window. The repeating BG marker is the only
      // stable readiness signal, and it also proves the pane is actually flooding.
      await waitForTerminalOutput(orcaPage, `BG:SSH_BULK_${runId}_0:`, 60_000, FLOOD_READ_CHARS)

      for (let i = 1; i < SESSION_SPLITS; i += 1) {
        await splitActiveTerminalPane(orcaPage, 'vertical')
        await focusLastTerminalPane(orcaPage)
        const panePtyId = await waitForActivePanePtyId(orcaPage, 30_000)
        await execInTerminal(orcaPage, panePtyId, continuousFloodCommand(runId, i))
        await waitForTerminalOutput(
          orcaPage,
          `BG:SSH_BULK_${runId}_${i}:`,
          60_000,
          FLOOD_READ_CHARS
        )
      }

      // Leave the workspace view so panes go inactive while flooding.
      await orcaPage.evaluate(() => window.__store?.getState().setActiveView('tasks'))
      await orcaPage.waitForTimeout(4_000)

      const hiddenProbe = await startRendererLagProbe(orcaPage)
      await orcaPage.waitForTimeout(2_000)
      const hiddenFloodMaxLagMs = await hiddenProbe.evaluate((probe) => probe.stop())
      await hiddenProbe.dispose()

      // Burst open: return to terminal and cycle panes rapidly.
      const openProbe = await startRendererLagProbe(orcaPage)
      await orcaPage.evaluate(() => window.__store?.getState().setActiveView('terminal'))
      for (let pass = 0; pass < 3; pass += 1) {
        for (let i = 0; i < SESSION_SPLITS; i += 1) {
          await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+]' : 'Control+]')
          await orcaPage.waitForTimeout(50)
        }
      }
      await orcaPage.waitForTimeout(3_000)
      const bulkOpenMaxLagMs = await openProbe.evaluate((probe) => probe.stop())
      await openProbe.dispose()

      const interactionProbeMs = await orcaPage.evaluate(async () => {
        const started = performance.now()
        const state = window.__store?.getState()
        const view = state?.activeView
        state?.setActiveView(view === 'tasks' ? 'terminal' : 'tasks')
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r()))
        )
        state?.setActiveView(view ?? 'terminal')
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r()))
        )
        return performance.now() - started
      })

      const report = {
        topology: 'docker-ssh' as const,
        sessionCount: SESSION_SPLITS,
        hiddenFloodMaxLagMs,
        bulkOpenMaxLagMs,
        interactionProbeMs,
        softFreeze:
          bulkOpenMaxLagMs >= SOFT_FREEZE_LAG_MS || interactionProbeMs >= SOFT_FREEZE_LAG_MS,
        hardFreeze:
          bulkOpenMaxLagMs >= HARD_FREEZE_LAG_MS || interactionProbeMs >= HARD_FREEZE_LAG_MS,
        container: target.containerName,
        remoteHostStillStreaming: true
      }

      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(REPORT_DIR, { recursive: true })
      writeFileSync(
        path.join(REPORT_DIR, 'bulk-open-freeze-docker-ssh.json'),
        `${JSON.stringify(report, null, 2)}\n`
      )
      console.log('[freeze-repro R2]', JSON.stringify(report, null, 2))

      // Host still producing frames (host alive, client stuck).
      const hostFrames = execDockerSshRelayTargetCommand(
        target,
        `ps aux | grep -c '[n]ode -e' || true`
      )
      expect(Number(hostFrames) || 0).toBeGreaterThan(0)

      if (report.hardFreeze) {
        throw new Error(
          `HARD FREEZE on Docker SSH: lag=${bulkOpenMaxLagMs.toFixed(0)}ms interaction=${interactionProbeMs.toFixed(0)}ms`
        )
      }
      if (report.softFreeze) {
        throw new Error(
          `SOFT FREEZE on Docker SSH: lag=${bulkOpenMaxLagMs.toFixed(0)}ms interaction=${interactionProbeMs.toFixed(0)}ms`
        )
      }
    } finally {
      if (target) {
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})

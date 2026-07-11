/**
 * Repro + recovery for the dead-push-delivery wedge (field snapshot,
 * v1.4.121-rc.0, 2026-07-06): every `pty:data` push event vanishes before the
 * renderer processes it while invoke IPC stays healthy — terminals go
 * literally blank (bytes sent, never consumed, never ACKed) and previously
 * only a renderer reload recovered.
 *
 * The `__terminalDeliveryWatchdog.blackhole` hook drops incoming pty:data at
 * the dispatcher exactly as the field failure does (no receive count, no ACK,
 * no handler). The watchdog must then confirm the wedge over invoke, write off
 * the lost bytes in main, and repaint the pane from the main-owned buffer
 * snapshot — all WITHOUT the push channel and WITHOUT a reload. The wedged
 * output becomes visible while the blackhole is still engaged: that is the
 * pull-recovery proof.
 *
 * Timing: the watchdog runs at 500ms ticks here, but main refuses a write-off
 * until it has seen 10s of ACK silence (PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS,
 * a deliberate prod constant) — so recovery lands at ~11-13s and the polls
 * below allow 30s.
 */
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  waitForActiveTerminalManager,
  waitForActivePanePtyId,
  execInTerminal,
  getTerminalContent
} from './helpers/terminal'

type DeliveryWatchdogWindow = Window & {
  __terminalDeliveryWatchdog?: {
    blackhole: (on: boolean) => void
    configure: (config: {
      intervalMs?: number
      stallTicksToHeal?: number
      healCooldownMs?: number
    }) => void
    snapshot: () => {
      receivedPtyDataEventCount: number
      stallStreakTicks: number
      healCount: number
      blackholed: boolean
    }
  }
}

test.describe('terminal push-delivery loss recovery', () => {
  test.afterEach(async ({ orcaPage }) => {
    await orcaPage.evaluate(() => {
      ;(window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.blackhole(false)
    })
  })

  test('watchdog repaints wedged terminals from the main buffer without push delivery or reload', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)

    // Live baseline: push delivery works. The $((…)) arithmetic keeps the
    // asserted string out of the typed command's local echo.
    await execInTerminal(orcaPage, ptyId, 'echo live-before-$((41+1))')
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 15_000 })
      .toContain('live-before-42')

    // Engage the field wedge and speed the watchdog up for CI.
    await orcaPage.evaluate(() => {
      const watchdog = (window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog
      if (!watchdog) {
        throw new Error('delivery watchdog e2e hook missing — exposeStore build?')
      }
      watchdog.configure({ intervalMs: 500, healCooldownMs: 3_000 })
      watchdog.blackhole(true)
    })

    await execInTerminal(orcaPage, ptyId, 'echo wedged-$((100+23))')

    // The wedge repro itself: output is swallowed, pane stays stale.
    await orcaPage.waitForTimeout(1_500)
    expect(await getTerminalContent(orcaPage)).not.toContain('wedged-123')

    // Pull-recovery proof: while the push channel is still dead, the healed
    // pane repaints from the main-owned snapshot and shows the wedged output.
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 30_000 })
      .toContain('wedged-123')
    const healSnapshot = await orcaPage.evaluate(
      () => (window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.snapshot() ?? null
    )
    expect(healSnapshot?.healCount ?? 0).toBeGreaterThan(0)

    // Channel restored: live output flows again with no reload in between.
    await orcaPage.evaluate(() => {
      ;(window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.blackhole(false)
    })
    await execInTerminal(orcaPage, ptyId, 'echo live-after-$((200+56))')
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 15_000 })
      .toContain('live-after-256')
  })
})

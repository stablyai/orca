import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

// #8104-class freeze: xterm WriteBuffer callback throws or disposed writes lose completion, wedging future output despite a live PTY.
// Verified on vendored 6.1.0-beta.287; require recovery beyond the replay guard’s wedged-release breadcrumb.

async function wedgeActivePaneWritePipeline(
  page: Parameters<typeof waitForSessionReady>[0]
): Promise<void> {
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
      throw new Error('No active terminal pane to wedge')
    }
    // #2836: uncaught _innerWrite callback skips rescheduling; write() re-arms only an empty buffer, so queued output never drains.
    pane.terminal.write('', () => {
      throw new Error('e2e: simulated unguarded write-completion throw')
    })
  })
}

test.describe('Wedged terminal write pipeline recovery', () => {
  test('pane recovers rendering and input after its write pipeline wedges', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForActivePanePtyId(orcaPage)
    await focusActiveTerminalInput(orcaPage)

    // Prove the pane is healthy first.
    const runId = Date.now()
    const beforeMarker = `WEDGE_BASELINE_${runId}`
    await orcaPage.keyboard.type(`echo ${beforeMarker}`, { delay: 20 })
    await orcaPage.keyboard.press('Enter')
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(beforeMarker), {
        timeout: 15_000,
        message: 'Baseline echo did not render — pane unhealthy before wedge'
      })
      .toBe(true)

    await wedgeActivePaneWritePipeline(orcaPage)

    // Require echo after typing through the wedge: live PTY alone cannot make a wedged parser render it.
    const afterMarker = `WEDGE_RECOVERED_${runId}`
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type(`echo ${afterMarker}`, { delay: 20 })
    await orcaPage.keyboard.press('Enter')

    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(afterMarker), {
        // Generous: recovery is certified by a probe write with a 10s stall
        // check, so the rebuild can legitimately take >20s to kick in.
        timeout: 45_000,
        message:
          'Pane never rendered output typed after the write pipeline wedged — wedged pane was not recovered'
      })
      .toBe(true)
  })

  test('pane recovers after its xterm is disposed under live bindings (zombie pane)', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await focusActiveTerminalInput(orcaPage)

    const runId = Date.now()
    const beforeMarker = `ZOMBIE_BASELINE_${runId}`
    await orcaPage.keyboard.type(`echo ${beforeMarker}`, { delay: 20 })
    await orcaPage.keyboard.press('Enter')
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(beforeMarker), {
        timeout: 15_000,
        message: 'Baseline echo did not render — pane unhealthy before dispose'
      })
      .toBe(true)

    // Model teardown racing bindings: delivery/input still target disposed xterm, whose dropped completions leak ACKs and suppress onData (6.1.0-beta.287).
    await orcaPage.evaluate(() => {
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
        throw new Error('No active terminal pane to dispose')
      }
      pane.terminal.dispose()
    })

    // Generate output daemon-side as the health signal; disposed xterm emits no keyboard onData.
    const outputMarker = `ZOMBIE_OUTPUT_${runId}`
    await sendToTerminal(orcaPage, ptyId, `echo ${outputMarker}\r`)

    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(outputMarker), {
        timeout: 45_000,
        message:
          'Output written after the pane xterm was disposed never rendered — zombie pane was not recovered'
      })
      .toBe(true)

    // Input must be live again end-to-end after recovery.
    await focusActiveTerminalInput(orcaPage)
    const typedMarker = `ZOMBIE_INPUT_${runId}`
    await orcaPage.keyboard.type(`echo ${typedMarker}`, { delay: 20 })
    await orcaPage.keyboard.press('Enter')
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(typedMarker), {
        timeout: 15_000,
        message: 'Typed input never reached the PTY after zombie-pane recovery'
      })
      .toBe(true)
  })
})

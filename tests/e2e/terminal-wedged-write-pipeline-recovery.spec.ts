import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

// Repro for the permanent frozen-pane state behind issue #8104-class reports:
// once a pane's xterm WriteBuffer wedges (an escaping throw from an unguarded
// write callback, or a write into a disposed terminal silently dropping its
// completion — both verified against vendored xterm 6.1.0-beta.287), every
// later write queues forever: output stops rendering while the PTY stays
// alive. The replay guard's probe certifies the wedge and fires the
// terminal_replay_guard_wedged_release breadcrumb ("pane likely needs
// recovery") — but nothing performs that recovery, so the pane stays a fossil
// until the user reloads the window. These tests pin the recovery contract.

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
    // Same escape class as issue #2836: WriteBuffer._innerWrite invokes write
    // callbacks with no try/catch; a synchronous throw skips the loop's tail
    // re-schedule and write() only re-arms on an EMPTY buffer, so the pipeline
    // never drains again.
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

    // Type through the wedge. The PTY is alive: bytes reach the shell and the
    // shell echoes them — but a wedged pipeline never parses the echo, so
    // without recovery the marker never renders.
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

    // The production zombie: disposePane/teardown raced pane bindings, leaving
    // delivery and input routed at a disposed xterm. write() on a disposed
    // terminal silently drops its completion callback (verified against
    // 6.1.0-beta.287), so delivery acks leak and keyboard onData never fires —
    // the pane looks painted but is a fossil: input dead, output dead, PTY alive.
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

    // Generate PTY output daemon-side; delivery into the disposed xterm is the
    // health signal recovery must catch (typing can't be one here — a disposed
    // xterm emits no onData at all).
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

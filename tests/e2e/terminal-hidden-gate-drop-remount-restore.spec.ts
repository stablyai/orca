import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneIdentitySnapshot } from './helpers/terminal'
import {
  createActiveTerminalTab,
  parkHiddenTabBehindDecoy
} from './helpers/terminal-hidden-parking'
import { getTerminalContentForPtyId, waitForPtyShellEcho } from './terminal-pty-readiness'

// Why: production cold-park hysteresis is 30s; scope the fast-park override to
// this spec's app launches (see terminal-hidden-view-parking.spec.ts).
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

const PAD_LINES = 40

type HiddenDeliveryDebug = {
  gatedPtyCount: number
  droppedChars: number
  droppedChunks: number
}

async function readHiddenDeliveryDebug(page: Page): Promise<HiddenDeliveryDebug> {
  return page.evaluate(async () => {
    const snapshot = await window.api.pty.getRendererDeliveryDebugSnapshot()
    return {
      gatedPtyCount: snapshot.hiddenDeliveryGatedPtyCount,
      droppedChars: snapshot.hiddenDeliveryDroppedChars,
      droppedChunks: snapshot.hiddenDeliveryDroppedChunks
    }
  })
}

async function resetHiddenDeliveryDebug(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.api.pty.resetRendererDeliveryDebug()
  })
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal')
    state.setActiveTab(targetTabId)
  }, tabId)
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: `terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
}

// Why a gated writer instead of a timed one: the payload must land in the exact
// window where the pane is mounted-but-hidden. The script announces itself, then
// blocks on a file only the test creates, so no wait in this spec is a sleep.
// It never exits — a shell prompt redraw after the park would re-arm main's drop
// latch and heal the very loss under test.
function releaseGatedMarkerScript(releasePath: string, ready: string, payload: string): string {
  return [
    `const fs = require('node:fs')`,
    `process.stdout.write(${JSON.stringify(`${ready}\n`)})`,
    `const poll = setInterval(() => {`,
    `  if (!fs.existsSync(${JSON.stringify(releasePath)})) return`,
    `  clearInterval(poll)`,
    `  process.stdout.write(${JSON.stringify(payload)})`,
    `  setInterval(() => {}, 1000)`,
    `}, 50)`,
    ''
  ].join('\n')
}

function hiddenPayload(runId: string): string {
  const lines = Array.from({ length: PAD_LINES }, (_, index) => `HIDDEN_GATE_PAD_${runId}_${index}`)
  lines.push(`HIDDEN_GATE_MARKER_${runId}`)
  return `${lines.join('\r\n')}\r\n`
}

test.describe('Hidden terminal delivery gate across a pane remount', () => {
  // Journey gate, not an STA-4869 R6 red/green: measured on this branch, the
  // replacement pane paints the withheld bytes from the provider reattach replay
  // (applyReattachPayload → writeReplayData), never from a model snapshot, so it
  // stays green with the R6 latch fix reverted. Main's drop latch is the second,
  // redundant route to the same bytes. What this does protect is the user-visible
  // end of the gate: output main withheld while the pane was hidden must still be
  // on screen after that pane retires and remounts.
  test('restores gated output after the hidden pane retires and remounts', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const liveSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const tabAId = liveSnapshot.tabId
    const ptyId = liveSnapshot.panes[0]?.ptyId
    if (!ptyId) {
      throw new Error('hidden gate drop spec: tab A did not bind a PTY')
    }
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

    const runId = randomUUID()
    const marker = `HIDDEN_GATE_MARKER_${runId}`
    const ready = `HIDDEN_GATE_ARMED_${runId}`
    const releasePath = path.join(tmpdir(), `orca-hidden-gate-release-${runId}`)
    const staged = await runNodeScriptInTerminal(
      orcaPage,
      ptyId,
      releaseGatedMarkerScript(releasePath, ready, hiddenPayload(runId)),
      { prefix: 'orca-hidden-gate-drop' }
    )
    try {
      await expect
        .poll(() => getTerminalContentForPtyId(orcaPage, ptyId, 40_000), {
          timeout: 20_000,
          message: 'gated writer never announced itself while tab A was visible'
        })
        .toContain(ready)

      // Hide tab A behind a decoy: the pane stays mounted, so it still owns the
      // hidden-delivery claim that makes main gate this PTY's bytes.
      await createActiveTerminalTab(orcaPage, worktreeId)
      await expect
        .poll(async () => (await readHiddenDeliveryDebug(orcaPage)).gatedPtyCount, {
          timeout: 15_000,
          message: 'hiding tab A did not mark any PTY hidden in main'
        })
        .toBeGreaterThan(0)

      await resetHiddenDeliveryDebug(orcaPage)
      writeFileSync(releasePath, 'go')

      // Oracle for "the bytes were really withheld": main counted them as gated
      // drops, and they never reached tab A's still-mounted xterm.
      await expect
        .poll(async () => (await readHiddenDeliveryDebug(orcaPage)).droppedChars, {
          timeout: 20_000,
          message: 'the released payload was not withheld from the renderer'
        })
        .toBeGreaterThan(1024)
      const gatedDebug = await readHiddenDeliveryDebug(orcaPage)
      expect(gatedDebug.droppedChunks).toBeGreaterThan(0)
      expect(await getTerminalContentForPtyId(orcaPage, ptyId, 40_000)).not.toContain(marker)

      // The R6 trigger: cold-park retires the hidden pane's view. Its dispose
      // releases the hidden claim, and no further bytes flow while parked, so
      // the latch main holds is the only route back to the withheld output.
      await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabAId, {
        parkDelayMs: PARKING_DELAY_MS
      })

      await activateTerminalTab(orcaPage, tabAId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const revealed = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(revealed.tabId).toBe(tabAId)
      expect(revealed.panes[0]?.ptyId).toBe(ptyId)

      await expect
        .poll(() => getTerminalContentForPtyId(orcaPage, ptyId, 40_000), {
          timeout: 20_000,
          message: 'output gated while hidden was lost across the pane remount'
        })
        .toContain(marker)
      const restored = await getTerminalContentForPtyId(orcaPage, ptyId, 40_000)
      expect(restored).toContain(`HIDDEN_GATE_PAD_${runId}_${PAD_LINES - 1}`)
      expect(restored).not.toContain('Orca skipped hidden terminal output')

      testInfo.annotations.push({
        type: 'hidden-delivery-gate',
        description: `droppedChars=${gatedDebug.droppedChars} droppedChunks=${gatedDebug.droppedChunks}`
      })
    } finally {
      staged.cleanup()
      rmSync(releasePath, { force: true })
    }
  })
})

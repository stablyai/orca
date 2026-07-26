import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

// A Codex-like agent: pre-fills scrollback, then keeps streaming — commits a
// row and redraws a synchronized-output "Working…" status frame every tick.
// The stream continues while the pane is hidden, which is what routes the
// return through the hidden-output snapshot restore.
function streamingAgentFixtureScript(runId: string): string {
  return `
async function writeStdout(chunk) {
  await new Promise((resolve) => process.stdout.write(chunk, resolve))
}
let row = 0
let pre = ''
for (; row < 300; row += 1) {
  pre += 'STREAMING_SWITCH_${runId}_ROW_' + String(row).padStart(4, '0') + '\\n'
}
await writeStdout(pre + 'STREAMING_SWITCH_${runId}_PRESTREAM_DONE\\n')
const spinner = ['|', '/', '-', '\\\\']
for (let tick = 0; tick < 800; tick += 1) {
  let frame = '\\x1b[?2026h'
  if (tick % 3 === 0) {
    frame += '\\r\\x1b[2KSTREAMING_SWITCH_${runId}_ROW_' + String(row).padStart(4, '0') + '\\n'
    row += 1
  }
  frame += '\\r\\x1b[2KWorking… ' + spinner[tick % 4] + ' tick=' + tick + '\\x1b[?2026l'
  await writeStdout(frame)
  await new Promise((resolve) => setTimeout(resolve, 50))
}
`
}

async function closeFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    store?.getState().markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    if (store?.getState().activeModal === 'feature-tips') {
      store.getState().closeModal()
    }
  })
}

async function pinActiveTerminalNearBottom(page: Page): Promise<{
  tabId: string
  targetViewportY: number
  baseY: number
}> {
  return page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!tabId || !pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const target = pane.container.querySelector<HTMLElement>('.xterm') ?? pane.container
    target.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: -240
      })
    )
    const buffer = pane.terminal.buffer.active
    const targetViewportY = Math.max(0, buffer.baseY - 6)
    pane.terminal.scrollToLine(targetViewportY)
    pane.container
      .querySelector<HTMLElement>('.xterm-viewport')
      ?.dispatchEvent(new Event('scroll', { bubbles: true }))
    return { tabId, targetViewportY, baseY: buffer.baseY }
  })
}

async function readSettledViewport(
  page: Page,
  tabId: string
): Promise<{ viewportY: number; baseY: number }> {
  // Wait until the replay has actually parsed (scrollback regrew) and the
  // viewport stopped moving, then report where it settled.
  let last: { viewportY: number; baseY: number } | null = null
  let stableCount = 0
  await expect
    .poll(
      async () => {
        const current = await page.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          const buffer = pane?.terminal?.buffer?.active
          return buffer ? { viewportY: buffer.viewportY, baseY: buffer.baseY } : null
        }, tabId)
        if (!current || current.baseY < 100) {
          stableCount = 0
          last = current
          return false
        }
        if (last && current.viewportY === last.viewportY) {
          stableCount += 1
        } else {
          stableCount = 0
        }
        last = current
        return stableCount >= 3
      },
      {
        timeout: 20_000,
        intervals: [250],
        message: 'terminal viewport did not settle after returning to the streaming worktree'
      }
    )
    .toBe(true)
  if (!last) {
    throw new Error('viewport settle poll finished without a sample')
  }
  return last
}

test.describe('Terminal pinned viewport with streaming agent across worktree switch', () => {
  test('returning to a pinned pane with an active stream does not land at the top', async ({
    orcaPage,
    testRepoPath
  }) => {
    await waitForSessionReady(orcaPage)
    await closeFeatureTips(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'streaming pinned repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-streaming-switch-${runId}.mjs`)
    writeFileSync(scriptPath, streamingAgentFixtureScript(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 15_000,
          message: 'streaming fixture did not reach terminal scrollback'
        })
        .toContain(`STREAMING_SWITCH_${runId}_PRESTREAM_DONE`)

      const pinned = await pinActiveTerminalNearBottom(orcaPage)
      expect(pinned.baseY).toBeGreaterThan(100)
      await orcaPage.waitForTimeout(150)

      // Stream continues while hidden; hidden byte drops mark the pane for a
      // snapshot restore on return.
      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(3_000)

      await switchToWorktree(orcaPage, firstWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)

      const settled = await readSettledViewport(orcaPage, pinned.tabId)
      const bottomDistance = settled.baseY - settled.viewportY
      // The user pinned six rows above the bottom. A faithful restore keeps
      // them near the pin; the bug clamps to the very top of the scrollback.
      expect(
        settled.viewportY,
        `settled at viewportY=${settled.viewportY} baseY=${settled.baseY} (pinned ${JSON.stringify(pinned)})`
      ).toBeGreaterThan(20)
      expect(
        bottomDistance,
        `settled ${bottomDistance} rows above the bottom (pinned 6 rows above)`
      ).toBeGreaterThan(1)
      expect(
        bottomDistance,
        `settled ${bottomDistance} rows above the bottom (pinned 6 rows above)`
      ).toBeLessThan(80)
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})

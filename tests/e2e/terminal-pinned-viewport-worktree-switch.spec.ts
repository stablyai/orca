import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/mcode-app'
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

type ViewportSample = { at: number; viewportY: number; baseY: number }

function scrollbackFixtureScript(runId: string): string {
  return `
async function writeStdout(chunk) {
  await new Promise((resolve) => process.stdout.write(chunk, resolve))
  if (process.platform === 'win32') await new Promise((resolve) => setTimeout(resolve, 8))
}
await writeStdout('\\x1b[?2026h\\x1b[2J\\x1b[H')
for (let index = 0; index < 180; index += 1) {
  await writeStdout('PINNED_VIEWPORT_SWITCH_${runId}_ROW_' + String(index).padStart(3, '0') + '\\n')
}
await writeStdout('\\x1b[?2026l')
await writeStdout('PINNED_VIEWPORT_SWITCH_${runId}_DONE\\n')
`
}

async function closeFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    store?.getState().markFeatureTipsSeen(['mcode-cli', 'cmd-j-palette', 'voice-dictation'])
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

async function sampleTerminalViewportDuringReturn(
  page: Page,
  tabId: string,
  durationMs: number
): Promise<ViewportSample[]> {
  return page.evaluate(
    ({ tabId, durationMs }) =>
      new Promise<ViewportSample[]>((resolve) => {
        const samples: ViewportSample[] = []
        const startedAt = performance.now()
        const sample = (): void => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          const buffer = pane?.terminal?.buffer?.active
          if (buffer) {
            samples.push({
              at: Math.round(performance.now() - startedAt),
              viewportY: buffer.viewportY,
              baseY: buffer.baseY
            })
          }
          if (performance.now() - startedAt >= durationMs) {
            resolve(samples)
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
    { tabId, durationMs }
  )
}

test.describe('Terminal pinned viewport worktree switch', () => {
  test('does not jump or flash when returning to a viewport pinned just above bottom', async ({
    mcodePage,
    testRepoPath
  }) => {
    await waitForSessionReady(mcodePage)
    await closeFeatureTips(mcodePage)
    const firstWorktreeId = await waitForActiveWorktree(mcodePage)
    const secondWorktreeId = (await getAllWorktreeIds(mcodePage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'pinned viewport repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(mcodePage)
    await waitForActiveTerminalManager(mcodePage, 30_000)
    const ptyId = await waitForActivePanePtyId(mcodePage)
    await waitForPtyShellEcho(mcodePage, ptyId, 15_000)
    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.mcode-pinned-viewport-${runId}.mjs`)
    writeFileSync(scriptPath, scrollbackFixtureScript(runId))

    try {
      await sendToTerminal(mcodePage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await expect
        .poll(() => getTerminalContent(mcodePage, 30_000), {
          timeout: 10_000,
          message: 'pinned viewport fixture did not reach terminal scrollback'
        })
        .toContain(`PINNED_VIEWPORT_SWITCH_${runId}_DONE`)

      const pinned = await pinActiveTerminalNearBottom(mcodePage)
      expect(pinned.baseY).toBeGreaterThan(20)
      await mcodePage.waitForTimeout(50)
      await switchToWorktree(mcodePage, secondWorktreeId)
      await waitForActiveTerminalManager(mcodePage, 30_000)
      await mcodePage.waitForTimeout(250)

      const samplesPromise = sampleTerminalViewportDuringReturn(mcodePage, pinned.tabId, 450)
      await switchToWorktree(mcodePage, firstWorktreeId)
      await ensureTerminalVisible(mcodePage)
      await waitForActiveTerminalManager(mcodePage, 30_000)
      const samples = await samplesPromise
      expect(samples.length).toBeGreaterThan(0)
      expect(samples.filter((sample) => sample.viewportY <= 1)).toEqual([])
      expect(samples.filter((sample) => sample.viewportY >= sample.baseY - 1)).toEqual([])
      expect(
        samples.filter((sample) => Math.abs(sample.viewportY - pinned.targetViewportY) > 1)
      ).toEqual([])
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})

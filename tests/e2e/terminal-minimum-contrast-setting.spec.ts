/**
 * E2E for #10754: the terminal contrast floor must be user-configurable.
 *
 * User Prompt:
 * - a TUI's deliberately low-contrast colors (Powerline seams, dimmed secondary text) must be
 *   renderable untouched, so the correction needs an opt-out that reaches every live pane
 *
 * Why compare renders instead of asserting one color: xterm applies the correction in the renderer,
 * so the cell's SGR attributes keep reporting the original color whatever the floor does, and the
 * painted value is shifted by DPR and the compositor's color management. Two renders of the same
 * buffer under different floors are directly comparable though, so the test drives the setting to
 * both ends of its range and asserts the pixels move, then come back. That also stays valid whether
 * the harness runs a light or dark terminal theme, which decides the default floor.
 */

import { PNG } from 'pngjs'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  discoverActivePtyId,
  execInTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { waitForSessionReady, ensureTerminalVisible } from './helpers/store'

const PROBE_MARKER = 'CONTRAST_PROBE'
// xterm 240 on 236 (1.97:1) and 245 on 238 (2.82:1): the two shapes the report is about, a Powerline
// seam and dimmed secondary text. Solid blocks so each cell is a flat slab of the foreground color.
const PROBE_COMMAND = [
  `printf '${PROBE_MARKER} '`,
  `printf '\\033[48;5;236m\\033[38;5;240m${'█'.repeat(24)}\\033[0m'`,
  `printf '\\033[48;5;238m\\033[38;5;245m${'█'.repeat(24)}\\033[0m\\n'`
].join(' && ')

// Antialiasing and subpixel work leave small per-pixel jitter that is not a color change.
const CHANNEL_TOLERANCE = 4

type Box = { x: number; y: number; width: number; height: number }

async function readTerminalScreenBox(page: Page): Promise<Box> {
  return page.evaluate(() => {
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
    const screen = pane?.container.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) {
      throw new Error('No active terminal pane to capture')
    }
    const rect = screen.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error('Active terminal screen is not visible for raster capture')
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

/** The floor xterm is actually enforcing on the live pane, not the stored setting. */
async function readAppliedContrastRatio(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
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
    return pane?.terminal?.options?.minimumContrastRatio
  })
}

async function captureTerminal(page: Page, box: Box): Promise<PNG> {
  return PNG.sync.read(await page.screenshot({ clip: box }))
}

function countChangedPixels(a: PNG, b: PNG): number {
  if (a.data.length !== b.data.length) {
    throw new Error('Captures differ in size; the pane was resized mid-test')
  }
  let changed = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > CHANNEL_TOLERANCE ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > CHANNEL_TOLERANCE ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > CHANNEL_TOLERANCE
    ) {
      changed += 1
    }
  }
  return changed
}

async function setMinimumContrast(page: Page, value: number): Promise<void> {
  await page.evaluate(async (ratio) => {
    await window.__store?.getState().updateSettings({ terminalMinimumContrastRatio: ratio })
  }, value)
  await expect.poll(async () => readAppliedContrastRatio(page), { timeout: 10_000 }).toBe(value)
}

test.describe('terminal minimum contrast setting', () => {
  test('drives the live pane floor and repaints low-contrast colors', async ({
    orcaPage: page
  }) => {
    await waitForSessionReady(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page)

    // A blinking cursor would register as a pixel change unrelated to the floor.
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalCursorBlink: false })
    })

    const ptyId = await discoverActivePtyId(page)
    await execInTerminal(page, ptyId, PROBE_COMMAND)
    await waitForTerminalOutput(page, PROBE_MARKER)

    const box = await readTerminalScreenBox(page)

    // 1 is the opt-out the report asks for: xterm performs no correction at all.
    await setMinimumContrast(page, 1)
    const uncorrected = await captureTerminal(page, box)

    // 21 forces the strongest possible correction, so any pane still honoring the setting must
    // visibly repaint the probe. This end of the range works on a light or dark theme alike.
    await setMinimumContrast(page, 21)
    const corrected = await captureTerminal(page, box)
    expect(countChangedPixels(uncorrected, corrected)).toBeGreaterThan(500)

    // Going back must restore the untouched colors, so the opt-out is not one-way and the value is
    // re-read rather than latched. Repainting the existing buffer also proves the pane does not
    // need a reprint or restart for the setting to take effect.
    await setMinimumContrast(page, 1)
    const restored = await captureTerminal(page, box)
    expect(countChangedPixels(uncorrected, restored)).toBeLessThan(100)
  })
})

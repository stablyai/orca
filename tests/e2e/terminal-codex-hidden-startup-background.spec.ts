import { Buffer } from 'node:buffer'
import { PNG } from 'pngjs'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { stageNodeScriptForTerminal } from './helpers/run-node-script-in-terminal'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { getTerminalContent, waitForActiveTerminalManager } from './helpers/terminal'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '../../src/renderer/src/constants/terminal'

type CodexStartupBackgroundTarget = {
  clip: { x: number; y: number; width: number; height: number }
  cellWidth: number
  cellHeight: number
  cols: number
  row: number
  modelBackgroundCells: number
}

const COMPOSER_BG = { red: 72, green: 72, blue: 72 }

function codexLikeStartupCommand(marker: string): string {
  const script = [
    // Why: embedded as a literal — an argv marker would need per-shell quoting.
    `const marker = ${JSON.stringify(marker)};`,
    'const width = Math.max(60, process.stdout.columns || 100);',
    'const pad = (text) => (text + " ".repeat(width)).slice(0, width);',
    'const bg = "\\x1b[48;2;72;72;72m\\x1b[38;2;235;235;235m";',
    'const reset = "\\x1b[0m";',
    'let reply = "";',
    'const hasColor = (slot) => new RegExp("\\\\x1b\\\\]" + slot + ";rgba?:[0-9a-fA-F]{2,4}/[0-9a-fA-F]{2,4}/[0-9a-fA-F]{2,4}(?:/[0-9a-fA-F]{2,4})?(?:\\\\x07|\\\\x1b\\\\\\\\)").test(reply);',
    'const render = () => {',
    '  const colorsOk = hasColor(10) && hasColor(11);',
    '  const status = colorsOk ? "OSC_COLORS_OK" : "OSC_COLORS_MISSING";',
    '  const prefix = colorsOk ? bg : "";',
    '  const suffix = colorsOk ? reset : "";',
    '  process.stdout.write("\\x1b[?2026h\\x1b[2J\\x1b[H");',
    '  process.stdout.write("Codex hidden startup background repro " + status + "\\r\\n\\r\\n");',
    '  process.stdout.write(prefix + pad("> " + marker + " " + status + " type here") + suffix + "\\r\\n");',
    '  process.stdout.write("\\x1b[?2026l");',
    '};',
    'if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {',
    '  process.stdin.setRawMode(true);',
    '}',
    'process.stdin.resume();',
    'process.stdin.on("data", (chunk) => {',
    '  reply += chunk.toString("binary");',
    '});',
    'process.stdout.write("\\x1b]10;?\\x1b\\\\\\x1b]11;?\\x1b\\\\");',
    'setTimeout(render, 100);',
    'setInterval(() => {}, 1000);'
  ].join('')
  // Why: delivered via a temp file — `node -e` quoting is not PowerShell-safe (#8521).
  return stageNodeScriptForTerminal(script, { prefix: 'orca-codex-startup-bg' }).command
}

async function waitForHiddenTabPtyId(page: Page, tabId: string): Promise<string> {
  let ptyId: string | null = null
  await expect
    .poll(
      async () => {
        ptyId = await page.evaluate((targetTabId) => {
          const state = window.__store?.getState()
          if (!state) {
            return null
          }
          return state.ptyIdsByTabId[targetTabId]?.[0] ?? null
        }, tabId)
        return ptyId
      },
      {
        timeout: 20_000,
        message: `Hidden Codex terminal tab ${tabId} did not receive a PTY binding`
      }
    )
    .not.toBeNull()

  if (!ptyId) {
    throw new Error(`waitForHiddenTabPtyId: tab ${tabId} has no PTY id`)
  }
  return ptyId
}

async function mainSnapshotContains(page: Page, ptyId: string, text: string): Promise<boolean> {
  return page.evaluate(
    async ({ targetPtyId, expectedText }) => {
      const snapshot = await window.api.pty.getMainBufferSnapshot(targetPtyId, {
        scrollbackRows: 200
      })
      return snapshot?.data.includes(expectedText) ?? false
    },
    { targetPtyId: ptyId, expectedText: text }
  )
}

async function readCodexStartupBackgroundTarget(
  page: Page,
  marker: string
): Promise<CodexStartupBackgroundTarget> {
  return page.evaluate(
    ({ marker, expected }) => {
      const isExpectedBackground = (cell: unknown): boolean => {
        const record = cell as {
          isBgRGB?: () => boolean
          getBgColor?: () => number
        }
        if (!record?.isBgRGB?.()) {
          return false
        }
        const color = record.getBgColor?.() ?? 0
        const red = (color >> 16) & 0xff
        const green = (color >> 8) & 0xff
        const blue = color & 0xff
        return (
          Math.abs(red - expected.red) <= 3 &&
          Math.abs(green - expected.green) <= 3 &&
          Math.abs(blue - expected.blue) <= 3
        )
      }

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
        throw new Error('Active Codex terminal pane is unavailable')
      }
      const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
      const dimensions = pane.terminal._core?._renderService?.dimensions?.css?.cell
      if (!screen || !dimensions) {
        throw new Error('Active Codex terminal has no measurable xterm screen')
      }
      const rect = screen.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        throw new Error('Active Codex terminal screen is not visible')
      }
      const activeBuffer = pane.terminal.buffer.active
      for (let row = 0; row < pane.terminal.rows; row += 1) {
        const line = activeBuffer.getLine(activeBuffer.viewportY + row)
        const rowText = line?.translateToString(true) ?? ''
        if (!rowText.includes(marker)) {
          continue
        }
        let modelBackgroundCells = 0
        for (let col = 0; col < pane.terminal.cols; col += 1) {
          if (isExpectedBackground(line?.getCell(col))) {
            modelBackgroundCells += 1
          }
        }
        return {
          clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          cellWidth: dimensions.width,
          cellHeight: dimensions.height,
          cols: pane.terminal.cols,
          row,
          modelBackgroundCells
        }
      }
      throw new Error(`Could not find Codex startup background marker ${marker}`)
    },
    { marker, expected: COMPOSER_BG }
  )
}

function isExpectedBackgroundPixel(
  red: number,
  green: number,
  blue: number,
  alpha: number
): boolean {
  return (
    alpha >= 245 &&
    Math.abs(red - COMPOSER_BG.red) <= 8 &&
    Math.abs(green - COMPOSER_BG.green) <= 8 &&
    Math.abs(blue - COMPOSER_BG.blue) <= 8
  )
}

async function countVisibleBackgroundPixels(
  page: Page,
  target: CodexStartupBackgroundTarget
): Promise<number> {
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  const screenshot = Buffer.from(await page.screenshot())
  const image = PNG.sync.read(screenshot)
  const scaleX = image.width / viewport.width
  const scaleY = image.height / viewport.height
  const originX = Math.round(target.clip.x * scaleX)
  const originY = Math.round(target.clip.y * scaleY)
  const rowTop = originY + Math.round(target.row * target.cellHeight * scaleY)
  const yStart = rowTop + Math.round(target.cellHeight * scaleY * 0.25)
  const yEnd = rowTop + Math.round(target.cellHeight * scaleY * 0.75)
  const xEnd = Math.min(image.width, originX + Math.round(target.clip.width * scaleX))
  let count = 0
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = originX; x < xEnd; x += 1) {
      const offset = (y * image.width + x) * 4
      if (
        isExpectedBackgroundPixel(
          image.data[offset] ?? 0,
          image.data[offset + 1] ?? 0,
          image.data[offset + 2] ?? 0,
          image.data[offset + 3] ?? 0
        )
      ) {
        count += 1
      }
    }
  }
  return count
}

test.describe('Codex hidden startup composer background', () => {
  test('restores the input background when a Codex worktree first becomes visible', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'Codex hidden startup background repro needs a second worktree')
    if (!secondWorktreeId) {
      return
    }

    const marker = `CODEX_STARTUP_BG_${Date.now()}`
    const command = codexLikeStartupCommand(marker)
    const hiddenTabId = await orcaPage.evaluate(
      ({ worktreeId, command, eventName }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }
        window.dispatchEvent(
          new CustomEvent(eventName, {
            detail: { worktreeId }
          })
        )
        const state = store.getState()
        const tab = state.createTab(worktreeId, undefined, undefined, {
          activate: false,
          launchAgent: 'codex',
          recordInteraction: false
        })
        state.queueTabStartupCommand(tab.id, {
          command,
          launchAgent: 'codex',
          telemetry: {
            agent_kind: 'codex',
            launch_source: 'tab_bar_quick_launch',
            request_kind: 'new'
          }
        })
        state.setTabCustomTitle(tab.id, 'Codex hidden startup background', {
          recordInteraction: false
        })
        return tab.id
      },
      {
        worktreeId: secondWorktreeId,
        command,
        eventName: BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT
      }
    )

    const hiddenPtyId = await waitForHiddenTabPtyId(orcaPage, hiddenTabId)
    await expect
      .poll(() => mainSnapshotContains(orcaPage, hiddenPtyId, marker), {
        timeout: 20_000,
        message: 'Hidden Codex startup background never reached the main buffer snapshot'
      })
      .toBe(true)
    // Why: the renderer skip counter is dead under the Phase-4 main-side delivery
    // gate (#7214) — hidden bytes are dropped in main before reaching the renderer.
    // The main-buffer snapshot above proves the hidden output was handled; the
    // reveal restore below proves it repaints when the worktree first shows.

    await switchToWorktree(orcaPage, secondWorktreeId)
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), {
        timeout: 10_000,
        message: 'Hidden Codex worktree did not become active'
      })
      .toBe(secondWorktreeId)
    await orcaPage.evaluate((tabId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal')
    }, hiddenTabId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expect
      .poll(() => getTerminalContent(orcaPage, 8_000), {
        timeout: 10_000,
        message: 'First visible mount did not restore hidden Codex startup content'
      })
      .toContain(marker)

    let target: CodexStartupBackgroundTarget | null = null
    await expect
      .poll(
        async () => {
          try {
            const nextTarget = await readCodexStartupBackgroundTarget(orcaPage, marker)
            target = nextTarget
            return nextTarget.modelBackgroundCells >= Math.min(40, nextTarget.cols)
          } catch {
            target = null
            return false
          }
        },
        {
          timeout: 10_000,
          message: 'Hidden Codex startup content restored without the composer background'
        }
      )
      .toBe(true)
    if (!target) {
      throw new Error('Codex startup background target was not captured')
    }
    const visibleBackgroundPixels = await countVisibleBackgroundPixels(orcaPage, target)
    const minimumVisiblePixels = Math.round(
      target.modelBackgroundCells * target.cellWidth * target.cellHeight * 0.2
    )
    expect(visibleBackgroundPixels).toBeGreaterThanOrEqual(minimumVisiblePixels)
  })
})

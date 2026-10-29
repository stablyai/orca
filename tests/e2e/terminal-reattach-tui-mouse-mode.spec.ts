// #8291: after quit/relaunch, real alt-screen TUI drag/wheel must remain mouse reports rather than xterm row selection.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

const VISIBLE_TUI_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/visible-tui-scroll-fixture.cjs'
)

// Send the fixture’s wheel-down report; only post-relaunch bytes can repaint offset=1, fencing replay/reset completion.
const WHEEL_DOWN_REPORT = '\x1b[<65;10;10M'

// Own the seed repo: concurrent globalTeardown can delete the machine-global pointer’s repo mid-restart.
function createIsolatedProofRepo(): string {
  // Why realpathSync: macOS tmpdir symlinks through /private and Orca canonicalizes repo.path.
  const repoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-mouse-reattach-repo-')))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
  }
  git('init', '-q')
  git('config', 'user.email', 'e2e@test.local')
  git('config', 'user.name', 'E2E Test')
  writeFileSync(path.join(repoDir, 'README.md'), '# Orca mouse-mode reattach proof repo\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'Seed commit for the reattach mouse-mode proof')
  return repoDir
}

type TerminalSurface = {
  mouseEventsClass: boolean
  mouseTrackingMode: string
  hasSelection: boolean
  selectionText: string
  visibleText: string
  screen: { left: number; top: number; width: number; height: number; cellHeight: number }
}

// Flush xterm’s write queue and sample in one evaluate to avoid mid-replay mode/selection reads.
async function readTerminalSurface(page: Page): Promise<TerminalSurface | null> {
  return page.evaluate(async () => {
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
    const element = pane?.terminal?.element ?? null
    const screenElement = element?.querySelector<HTMLElement>('.xterm-screen') ?? null
    if (!pane || !element || !screenElement) {
      return null
    }
    // An empty write callback fences all earlier FIFO replay/reset writes.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      pane.terminal.write('', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    const buffer = pane.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < pane.terminal.rows; row += 1) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    }
    const rect = screenElement.getBoundingClientRect()
    return {
      mouseEventsClass: element.classList.contains('enable-mouse-events'),
      mouseTrackingMode: String(pane.terminal.modes?.mouseTrackingMode ?? 'unavailable'),
      hasSelection: pane.terminal.hasSelection(),
      selectionText: pane.terminal.getSelection(),
      visibleText: lines.join('\n'),
      screen: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        cellHeight: rect.height / Math.max(1, pane.terminal.rows)
      }
    }
  })
}

async function waitForTerminalSurface(
  page: Page,
  predicate: (surface: TerminalSurface) => boolean,
  message: string,
  timeoutMs = 30_000
): Promise<TerminalSurface> {
  await expect
    .poll(
      async () => {
        const surface = await readTerminalSurface(page)
        return surface !== null && predicate(surface)
      },
      { timeout: timeoutMs, message }
    )
    .toBe(true)
  const surface = await readTerminalSurface(page)
  if (!surface) {
    throw new Error(`${message}: terminal surface disappeared after settling`)
  }
  return surface
}

function readRenderedTuiOffset(visibleText: string): number | null {
  const match = /TUI_SCROLL_READY offset=(\d+)/.exec(visibleText)
  return match ? Number(match[1]) : null
}

/** Real CDP drag across three TUI rows — the gesture from the bug report. */
async function dragAcrossTuiRows(page: Page, screen: TerminalSurface['screen']): Promise<void> {
  const startX = screen.left + Math.min(24, screen.width / 4)
  const startY = screen.top + screen.cellHeight * 2.5
  const endX = screen.left + screen.width * 0.6
  const endY = startY + screen.cellHeight * 3
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(endX, endY, { steps: 12 })
  await page.mouse.up()
}

// Relaunch the same profile while its daemon and TUI remain alive.
test.describe.configure({ mode: 'serial' })

test.describe('terminal reattach mouse mode', () => {
  test('live TUI keeps mouse tracking after an app restart reattach instead of falling back to drag selection', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = createIsolatedProofRepo()
    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
      await waitForSessionReady(firstLaunch.page)
      await waitForActiveWorktree(firstLaunch.page)
      await ensureTerminalVisible(firstLaunch.page)
      await waitForActiveTerminalManager(firstLaunch.page, 30_000)
      await waitForPaneCount(firstLaunch.page, 1, 30_000)

      const firstPtyId = await waitForActivePanePtyId(firstLaunch.page)
      await execInTerminal(
        firstLaunch.page,
        firstPtyId,
        `node ${JSON.stringify(VISIBLE_TUI_FIXTURE_PATH)}`
      )

      const beforeRestart = await waitForTerminalSurface(
        firstLaunch.page,
        (surface) =>
          surface.visibleText.includes('TUI_SCROLL_READY') && surface.mouseEventsClass === true,
        'TUI fixture never armed mouse reporting before the restart'
      )
      expect(beforeRestart.mouseTrackingMode).toBe('any')

      // Closing the app leaves the detached daemon’s PTY/TUI alive.
      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)
      await waitForActiveWorktree(secondLaunch.page)
      await ensureTerminalVisible(secondLaunch.page)
      await waitForActiveTerminalManager(secondLaunch.page, 30_000)
      await waitForPaneCount(secondLaunch.page, 1, 30_000)
      await secondLaunch.page.evaluate(() =>
        window.__store?.getState().updateSettings({ terminalTuiScrollSensitivity: 1 })
      )

      // Require the wheel beacon’s offset=1 repaint to prove replay/reset completion without sleep.
      const secondPtyId = await waitForActivePanePtyId(secondLaunch.page)
      await sendToTerminal(secondLaunch.page, secondPtyId, WHEEL_DOWN_REPORT)
      const afterReattach = await waitForTerminalSurface(
        secondLaunch.page,
        (surface) => readRenderedTuiOffset(surface.visibleText) === 1,
        'Reattached pane never rendered the live TUI repaint after the restart'
      )

      await dragAcrossTuiRows(secondLaunch.page, afterReattach.screen)
      const afterDrag = await readTerminalSurface(secondLaunch.page)
      // Capture a screenshot: restart prevents video WebM flush; the frame must show no row-selection overlay on the live TUI.
      const proofShot = process.env.ORCA_E2E_PROOF_SCREENSHOT
      if (proofShot) {
        await secondLaunch.page.screenshot({ path: proofShot })
      }
      expect(afterDrag, 'terminal surface unavailable after the drag').not.toBeNull()
      expect(
        afterDrag!.selectionText,
        'dragging over a live mouse-tracking TUI must not paint xterm row selection'
      ).toBe('')
      expect(afterDrag!.hasSelection).toBe(false)

      const wheelTargetX = afterReattach.screen.left + afterReattach.screen.width / 2
      const wheelTargetY = afterReattach.screen.top + afterReattach.screen.height / 2
      await secondLaunch.page.mouse.move(wheelTargetX, wheelTargetY)
      for (let i = 0; i < 5; i += 1) {
        await secondLaunch.page.mouse.wheel(0, Math.min(49, afterReattach.screen.cellHeight))
      }
      const afterWheel = await waitForTerminalSurface(
        secondLaunch.page,
        (surface) => (readRenderedTuiOffset(surface.visibleText) ?? 0) > 1,
        'Wheel gestures never reached the reattached TUI — its rendered offset row never advanced',
        15_000
      )
      expect(readRenderedTuiOffset(afterWheel.visibleText)).toBeGreaterThan(1)
      expect(afterWheel.mouseEventsClass).toBe(true)
      expect(afterWheel.mouseTrackingMode).toBe('any')
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
})

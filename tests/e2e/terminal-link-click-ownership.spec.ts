import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { test, expect } from './helpers/mcode-app'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/terminal-link-mouse-owner-fixture.cjs'
)
const LINK = 'https://example.com/sta-3888'
const OSC_LINK_TEXT = 'STA_3888_OSC_LINK'

type LinkTarget = { x: number; y: number; mouseTrackingMode: string }
type LinkMode = 'http' | 'osc'

async function startMouseAwareLinkFixture(
  mcodePage: Page,
  testInfo: TestInfo,
  linkMode: LinkMode = 'http'
): Promise<{ mouseLogPath: string; ptyId: string; target: LinkTarget }> {
  await waitForSessionReady(mcodePage)
  await waitForActiveWorktree(mcodePage)
  await ensureTerminalVisible(mcodePage)
  await waitForActiveTerminalManager(mcodePage)
  await waitForPaneCount(mcodePage, 1)

  const ptyId = await waitForActivePanePtyId(mcodePage)
  const mouseLogPath = testInfo.outputPath('child-mouse-reports.log')
  await execInTerminal(
    mcodePage,
    ptyId,
    `node ${JSON.stringify(FIXTURE_PATH)} ${JSON.stringify(mouseLogPath)} ${linkMode}`
  )
  const renderedLinkText = linkMode === 'osc' ? OSC_LINK_TEXT : LINK
  await waitForTerminalOutput(mcodePage, 'LINK_MOUSE_READY')

  const target = await mcodePage.evaluate((linkText) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? null
    if (!pane || !screen) {
      throw new Error('Active terminal screen unavailable')
    }

    const buffer = pane.terminal.buffer.active
    for (let viewportRow = 0; viewportRow < pane.terminal.rows; viewportRow += 1) {
      const text = buffer.getLine(buffer.viewportY + viewportRow)?.translateToString(false)
      const column = text?.indexOf(linkText) ?? -1
      if (column < 0) {
        continue
      }
      const rect = screen.getBoundingClientRect()
      const cell = pane.terminal.dimensions?.css.cell
      if (!cell?.width || !cell.height) {
        throw new Error('Active terminal cell dimensions unavailable')
      }
      return {
        x: rect.left + (column + linkText.length / 2) * cell.width,
        y: rect.top + (viewportRow + 0.5) * cell.height,
        mouseTrackingMode: pane.terminal.modes.mouseTrackingMode
      }
    }
    throw new Error('Rendered fixture link unavailable')
  }, renderedLinkText)

  expect(target.mouseTrackingMode).not.toBe('none')
  return { mouseLogPath, ptyId, target }
}

function childMouseReportCount(mouseLogPath: string): number {
  if (!existsSync(mouseLogPath)) {
    return 0
  }
  return readFileSync(mouseLogPath, 'utf8').trim().split(/\s+/).filter(Boolean).length
}

async function expectChildMouseReports(mouseLogPath: string): Promise<void> {
  await expect
    .poll(() => childMouseReportCount(mouseLogPath), { timeout: 5_000 })
    .toBeGreaterThan(0)
}

async function expectMCodeOwnedMouseOutcome(mouseLogPath: string): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  expect(childMouseReportCount(mouseLogPath)).toBe(0)
}

test.describe('terminal link click ownership', () => {
  test('an MCode-owned plain link click emits no child PTY mouse frames', async ({
    mcodePage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(mcodePage, testInfo)
    await mcodePage.mouse.click(target.x, target.y)

    await expect(mcodePage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(mcodePage.locator('[data-terminal-link-destination]')).toHaveText(LINK)

    await expectMCodeOwnedMouseOutcome(mouseLogPath)

    await sendToTerminal(mcodePage, ptyId, 'q')
  })

  test('an MCode-owned OSC link click emits no child PTY mouse frames', async ({
    mcodePage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(
      mcodePage,
      testInfo,
      'osc'
    )
    await mcodePage.mouse.move(target.x, target.y)
    await expect(mcodePage.locator('.xterm-hover')).toHaveCount(1)
    await mcodePage.mouse.click(target.x, target.y)

    await expect(mcodePage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(mcodePage.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await expectMCodeOwnedMouseOutcome(mouseLogPath)

    await sendToTerminal(mcodePage, ptyId, 'q')
  })

  test('a plain click stays child-owned when link actions are disabled', async ({
    mcodePage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(mcodePage, testInfo)
    await mcodePage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalLinkActionPopoverEnabled: false })
    })

    await mcodePage.mouse.click(target.x, target.y)

    await expect(mcodePage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await expectChildMouseReports(mouseLogPath)
    await sendToTerminal(mcodePage, ptyId, 'q')
  })

  test('a drag across a link stays child-owned', async ({ mcodePage }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(mcodePage, testInfo)

    await mcodePage.mouse.move(target.x, target.y)
    await mcodePage.mouse.down()
    await mcodePage.mouse.move(target.x + 12, target.y + 12, { steps: 3 })
    await mcodePage.mouse.up()

    await expect(mcodePage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await expectChildMouseReports(mouseLogPath)
    await sendToTerminal(mcodePage, ptyId, 'q')
  })
})

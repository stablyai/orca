import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/terminal-link-file-preview-fixture.cjs'
)
const PREVIEW_SELECTOR = '[data-slot="link-action-preview"]'
const MOUSE_MODES = [1000, 1002, 1003] as const
const SGR_MOUSE_REPORT_PATTERN = new RegExp(String.raw`^\x1b\[<(\d+);\d+;\d+[Mm]$`)

type FileLinkPoint = {
  x: number
  y: number
  cellHeight: number
  rowsFromBottom: number
  bufferType: string
  mouseTrackingMode: string
}

async function locateFileLink(page: Page, link: string): Promise<FileLinkPoint> {
  return page.evaluate((link) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('Active terminal screen unavailable')
    }
    const terminal = pane.terminal
    const buffer = terminal.buffer.active
    // Absolute Windows/temp paths can wrap across physical rows.
    const visibleCells = Array.from({ length: terminal.rows }, (_, row) =>
      (buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? '').padEnd(terminal.cols)
    ).join('')
    const start = visibleCells.indexOf(link)
    const cell = terminal.dimensions?.css.cell
    if (start === -1 || !cell?.width || !cell.height) {
      throw new Error('Rendered file link or terminal cell dimensions unavailable')
    }
    const center = start + Math.floor(link.length / 2)
    const row = Math.floor(center / terminal.cols)
    const rect = screen.getBoundingClientRect()
    return {
      x: rect.left + ((center % terminal.cols) + 0.5) * cell.width,
      y: rect.top + (row + 0.5) * cell.height,
      cellHeight: cell.height,
      rowsFromBottom: terminal.rows - row,
      bufferType: buffer.type,
      mouseTrackingMode: terminal.modes.mouseTrackingMode
    }
  }, link)
}

async function startFileLinkFixture(
  page: Page,
  testInfo: TestInfo,
  filePath: string,
  mouseMode: number
): Promise<{ ptyId: string; mouseLogPath: string; target: FileLinkPoint }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(async () => {
    await window.__store?.getState().updateSettings({
      uiLanguage: 'en',
      terminalLinkActionPopoverEnabled: true,
      terminalLinkClickBehavior: 'actions',
      terminalLinkMenuFilePreview: true
    })
  })
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  await waitForPaneCount(page, 1)
  const ptyId = await waitForActivePanePtyId(page)
  await waitForPtyShellEcho(page, ptyId, 15_000)
  const mouseLogPath = testInfo.outputPath('child-mouse-reports.log')
  const printedPath = filePath.replaceAll('\\', '/')
  await execInTerminal(
    page,
    ptyId,
    nodeTerminalCommand([FIXTURE_PATH, mouseLogPath, printedPath, String(mouseMode)])
  )
  await waitForTerminalOutput(page, `FILE_PREVIEW_MOUSE_READY ${mouseMode}+1006`)
  const target = await locateFileLink(page, `${printedPath}:2`)
  expect(target.bufferType).toBe('alternate')
  expect(target.mouseTrackingMode).toBe(
    mouseMode === 1000 ? 'vt200' : mouseMode === 1002 ? 'drag' : 'any'
  )
  expect(target.rowsFromBottom).toBeLessThanOrEqual(3)
  return { ptyId, mouseLogPath, target }
}

function readChildInput(mouseLogPath: string): {
  buttonFrames: number
  motionFrames: number
  acknowledgements: number
} {
  const input = { buttonFrames: 0, motionFrames: 0, acknowledgements: 0 }
  if (!existsSync(mouseLogPath)) {
    return input
  }
  for (const entry of readFileSync(mouseLogPath, 'utf8').split('\n').filter(Boolean)) {
    if (entry === 'KEY p') {
      input.acknowledgements += 1
      continue
    }
    const frame = Buffer.from(entry, 'hex').toString('utf8')
    const match = SGR_MOUSE_REPORT_PATTERN.exec(frame)
    if (!match) {
      throw new Error(`Invalid child mouse frame: ${entry}`)
    }
    // SGR's motion bit also appears in 1003's no-button pointer reports.
    if (Number(match[1]) & 32) {
      input.motionFrames += 1
    } else {
      input.buttonFrames += 1
    }
  }
  return input
}

async function clickFileLink(page: Page, target: FileLinkPoint): Promise<Locator> {
  await page.mouse.move(target.x, target.y - target.cellHeight * 2)
  await page.mouse.move(target.x, target.y)
  const tooltip = page.locator('.pane-link-tooltip:visible')
  await expect(tooltip).toContainText('package.json')
  await page.mouse.click(target.x, target.y)
  const menu = page.locator('[data-terminal-link-action-popover]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-terminal-link-destination]')).toContainText('package.json')
  return menu
}

async function expectPreview(menu: Locator): Promise<void> {
  const preview = menu.locator(PREVIEW_SELECTOR)
  await expect(preview).toBeVisible()
  await expect(preview.locator('pre code')).toContainText('"name": "orca-e2e-test"')
  const marker = preview.locator('[data-current="true"]')
  await expect(marker).toBeVisible()
  const markerRect = await marker.boundingBox()
  const lineNumberRect = await preview.getByText('2', { exact: true }).boundingBox()
  if (!markerRect || !lineNumberRect) {
    throw new Error('Referenced line marker or line number is not rendered')
  }
  expect(Math.abs(markerRect.y - lineNumberRect.y)).toBeLessThanOrEqual(1)
  expect(await preview.evaluate((element) => element.contains(document.activeElement))).toBe(false)
}

async function expectTabSkipsPreview(page: Page, menu: Locator): Promise<void> {
  const preview = menu.locator(PREVIEW_SELECTOR)
  const scroller = preview.locator('.overflow-y-auto')
  expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true
  )

  const buttons = menu.getByRole('button')
  const count = await buttons.count()
  const reached = new Set<number>()
  await buttons.first().focus()
  for (let step = 0; step < count * 2; step += 1) {
    await page.keyboard.press('Tab')
    expect(await preview.evaluate((element) => element.contains(document.activeElement))).toBe(
      false
    )
    const focused = await buttons.evaluateAll((elements: Element[]) =>
      document.activeElement ? elements.indexOf(document.activeElement) : -1
    )
    if (focused !== -1) {
      reached.add(focused)
    }
  }
  expect(reached.size).toBe(count)
}

async function expectMenuWithinViewport(menu: Locator): Promise<void> {
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          left: Math.max(0, -rect.left),
          top: Math.max(0, -rect.top),
          right: Math.max(0, rect.right - window.innerWidth),
          bottom: Math.max(0, rect.bottom - window.innerHeight)
        }
      })
    )
    .toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
}

async function escapeAndCheckInput(
  page: Page,
  ptyId: string,
  mouseLogPath: string,
  acknowledgements: number
): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
  await expect(page.locator(`[data-pty-id="${ptyId}"] .xterm-helper-textarea`)).toBeFocused()
  // An in-band key acknowledgement fences earlier click input without a fixed sleep.
  await page.keyboard.press('p')
  await expect.poll(() => readChildInput(mouseLogPath).acknowledgements).toBe(acknowledgements)
  expect(readChildInput(mouseLogPath).buttonFrames).toBe(0)
}

test.describe('terminal link menu file preview', () => {
  for (const mouseMode of MOUSE_MODES) {
    test(`previews and opens a file without forwarding clicks under ${mouseMode}+1006`, async ({
      orcaPage,
      seededRepoPath
    }, testInfo) => {
      test.setTimeout(120_000)
      const filePath = path.join(seededRepoPath, 'package.json')
      const { ptyId, mouseLogPath, target } = await startFileLinkFixture(
        orcaPage,
        testInfo,
        filePath,
        mouseMode
      )
      try {
        const menu = await clickFileLink(orcaPage, target)
        await expectPreview(menu)
        await expectTabSkipsPreview(orcaPage, menu)
        await expectMenuWithinViewport(menu)
        const wide = await menu.evaluate((element) => {
          const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
          return {
            width: element.getBoundingClientRect().width,
            expected: Math.min(32 * rem, window.innerWidth - rem)
          }
        })
        expect(wide.width).toBeCloseTo(wide.expected, 0)
        await orcaPage.screenshot({ path: testInfo.outputPath('preview-near-terminal-bottom.png') })
        await escapeAndCheckInput(orcaPage, ptyId, mouseLogPath, 1)
        if (mouseMode === 1003) {
          expect(readChildInput(mouseLogPath).motionFrames).toBeGreaterThan(0)
        }

        await orcaPage.evaluate(async () => {
          await window.__store?.getState().updateSettings({ terminalLinkMenuFilePreview: false })
        })
        const compactMenu = await clickFileLink(orcaPage, target)
        await expect(compactMenu.locator(PREVIEW_SELECTOR)).toHaveCount(0)
        await expectMenuWithinViewport(compactMenu)
        const compact = await compactMenu.evaluate((element) => {
          const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
          return {
            width: element.getBoundingClientRect().width,
            legacyMax: Math.min(21 * rem, window.innerWidth - rem)
          }
        })
        expect(compact.width).toBeLessThanOrEqual(compact.legacyMax)
        expect(compact.width).toBeLessThan(wide.width)
        await escapeAndCheckInput(orcaPage, ptyId, mouseLogPath, 2)

        // Positive control: the same foreground program receives a non-link click.
        await orcaPage.mouse.click(target.x, target.y - target.cellHeight * 2)
        await expect.poll(() => readChildInput(mouseLogPath).buttonFrames).toBeGreaterThan(0)
        await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)

        await orcaPage.evaluate(async () => {
          await window.__store?.getState().updateSettings({ terminalLinkMenuFilePreview: true })
        })
        const openMenu = await clickFileLink(orcaPage, target)
        await expectPreview(openMenu)
        await openMenu.getByRole('button', { name: /Open file/i }).click()
        await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
        await expect(orcaPage.locator('.editor-header-path').first()).toContainText(
          'package.json',
          {
            timeout: 20_000
          }
        )
        await expect(orcaPage.locator('.monaco-editor .view-lines').first()).toContainText(
          'orca-e2e-test'
        )
      } finally {
        await sendToTerminal(orcaPage, ptyId, 'q')
      }
    })
  }
})

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import { resolveActiveTabId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  configureCopyMode,
  copiedModeText,
  expectCopyCursorReady,
  isolateCopyModeClipboard,
  pressCopyMotion,
  resetCopiedModeText,
  seedCopyModeScreen,
  startCopyModeTerminalProbe
} from './helpers/terminal-copy-mode-fixture'

async function sourceColumns(page: Page): Promise<number> {
  const tabId = await resolveActiveTabId(page)
  return page.evaluate((tabId) => {
    const terminal = tabId ? window.__paneManagers?.get(tabId)?.getActivePane()?.terminal : null
    if (!terminal) {
      throw new Error('No terminal for copy-mode layout')
    }
    return terminal.cols
  }, tabId)
}

async function expectFittedSnapshot(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator('.terminal-copy-mode-viewport').evaluate((element) => {
        const screen = element.querySelector('.xterm-screen')
        const cursor = element.querySelector('.terminal-copy-mode-cursor')
        if (!screen || !cursor) {
          return false
        }
        const bounds = element.getBoundingClientRect()
        const grid = screen.getBoundingClientRect()
        const point = cursor.getBoundingClientRect()
        return {
          overflowX: Math.max(0, element.scrollWidth - element.clientWidth),
          screenFits:
            grid.right <= bounds.left + element.clientWidth + 0.5 &&
            grid.bottom <= bounds.top + element.clientHeight + 0.5,
          cursorFits:
            point.left >= bounds.left &&
            point.right <= bounds.left + element.clientWidth + 0.5 &&
            point.top >= bounds.top &&
            point.bottom <= bounds.top + element.clientHeight + 0.5
        }
      })
    )
    .toEqual({ overflowX: 0, screenFits: true, cursorFits: true })
}

test.beforeEach(async ({ orcaPage, electronApp }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await isolateCopyModeClipboard(electronApp)
  await startCopyModeTerminalProbe(orcaPage)
  await configureCopyMode(orcaPage, { copyMode: { exitOnCopy: false } })
})

for (const { theme, classic } of [
  { theme: 'light', classic: true },
  { theme: 'dark', classic: true },
  { theme: 'light', classic: false }
] as const) {
  test(`snapshot fits and retains a wide-character selection across resizing (${theme} ${classic ? 'classic' : 'native'} scrollbars)`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await orcaPage.evaluate(
      (theme) => window.__store?.getState().updateSettingsOrThrow({ theme }),
      theme
    )
    if (classic) {
      await orcaPage.addStyleTag({
        content: '.terminal-copy-mode-viewport { scrollbar-gutter: stable; }'
      })
    }
    const original = await orcaPage.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const cols = await sourceColumns(orcaPage)
    await seedCopyModeScreen(orcaPage, `${'a'.repeat(cols - 1)}中e\u0301Z`)
    await pressShortcut(orcaPage, 'x', { shift: true })
    await expectCopyCursorReady(orcaPage)
    await expectFittedSnapshot(orcaPage)
    await pressCopyMotion(orcaPage, '$ v b b y')
    await expect.poll(() => copiedModeText(electronApp)).toBe('中e\u0301Z')
    await expectFittedSnapshot(orcaPage)
    await orcaPage.screenshot({ path: testInfo.outputPath('copy-mode-layout-wide.png') })
    await orcaPage.setViewportSize({ width: 1100, height: 720 })
    await expectFittedSnapshot(orcaPage)
    await resetCopiedModeText(electronApp)
    expect(await copiedModeText(electronApp)).toBeNull()
    await pressCopyMotion(orcaPage, 'y')
    await expect.poll(() => copiedModeText(electronApp)).toBe('中e\u0301Z')
    await orcaPage.screenshot({ path: testInfo.outputPath('copy-mode-layout-narrow.png') })
    await orcaPage.setViewportSize(original)
    await expectFittedSnapshot(orcaPage)
    await resetCopiedModeText(electronApp)
    expect(await copiedModeText(electronApp)).toBeNull()
    await pressCopyMotion(orcaPage, 'y')
    await expect.poll(() => copiedModeText(electronApp)).toBe('中e\u0301Z')
  })
}

test('narrowing the frozen view preserves the oldest retained logical line', async ({
  orcaPage,
  electronApp
}) => {
  const cols = await sourceColumns(orcaPage)
  const lines = Array.from(
    { length: 80 },
    (_, index) => `L${String(index).padStart(3, '0')} ${'x'.repeat(cols + 10)} 中`
  )
  await seedCopyModeScreen(orcaPage, lines.join('\r\n'))
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1100, height: 720 })
  await expectFittedSnapshot(orcaPage)
  for (let index = 0; index < 25; index += 1) {
    await pressCopyMotion(orcaPage, 'Control+u')
  }
  await pressCopyMotion(orcaPage, '0 v $ y')
  await expect.poll(() => copiedModeText(electronApp)).toBe(lines[0])
})

test('initial fitting keeps the source cursor on its wide character after a soft wrap', async ({
  orcaPage,
  electronApp
}) => {
  const cols = await sourceColumns(orcaPage)
  await seedCopyModeScreen(orcaPage, `header\r\n${'a'.repeat(cols - 1)}中Z`)
  const tabId = await resolveActiveTabId(orcaPage)
  await orcaPage.evaluate(async (tabId) => {
    const terminal = tabId ? window.__paneManagers?.get(tabId)?.getActivePane()?.terminal : null
    if (!terminal) {
      throw new Error('No terminal for wrapped cursor')
    }
    await new Promise<void>((resolve) => terminal.write('\x1b[3;1H', resolve))
  }, tabId)
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await expectFittedSnapshot(orcaPage)
  await pressCopyMotion(orcaPage, 'v y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('中')
})

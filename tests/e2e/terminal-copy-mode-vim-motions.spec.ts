import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import { resolveActiveTabId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'
import {
  configureCopyMode,
  copiedModeText,
  expectCopyCursorCell,
  expectCopyCursorReady,
  isolateCopyModeClipboard,
  pressCopyMotion,
  readCopyModeGridGeometry,
  seedCopyModeScreen,
  startCopyModeTerminalProbe
} from './helpers/terminal-copy-mode-fixture'

test.beforeEach(async ({ orcaPage, electronApp }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await isolateCopyModeClipboard(electronApp)
  await startCopyModeTerminalProbe(orcaPage)
  await configureCopyMode(orcaPage, { copyMode: { exitOnCopy: false } })
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettingsOrThrow({ terminalCopyTrimsGutter: false })
  )
})

test('Vim line boundaries and word motions work in both directions without PTY input', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await seedCopyModeScreen(orcaPage, '  alpha.beta  gamma   \r\n  second line  ')
  await installTerminalPtyWriteSpy(electronApp)
  await clearTerminalPtyWriteLog(electronApp)
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  const steps: [string, number][] = [
    ['^', 2],
    ['$', 21],
    ['g _', 18],
    ['0', 0],
    ['w', 2],
    ['w', 7],
    ['b', 2],
    ['e', 6],
    ['e', 7],
    ['g e', 6],
    ['w', 7],
    ['w', 8],
    ['e', 11],
    ['g e', 7],
    ['0', 0],
    ['W', 2],
    ['W', 14],
    ['B', 2],
    ['E', 11],
    ['E', 18],
    ['g E', 11]
  ]
  for (const [keys, column] of steps) {
    await pressCopyMotion(orcaPage, keys)
    await expectCopyCursorCell(orcaPage, 0, column)
  }
  await pressCopyMotion(orcaPage, '0')
  for (const keys of [
    'g g',
    'g k',
    'g j',
    'G',
    'H',
    'L',
    'M',
    'Control+b',
    'Control+f',
    '{',
    '}',
    '(',
    ')',
    'f',
    'F',
    't',
    'T',
    ';',
    ',',
    '%'
  ]) {
    await pressCopyMotion(orcaPage, keys)
    await expectCopyCursorCell(orcaPage, 0, 0)
  }
  await pressCopyMotion(orcaPage, '3 w')
  await expectCopyCursorCell(orcaPage, 0, 2)
  await pressCopyMotion(orcaPage, '0 ^ v g _ y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('alpha.beta  gamma')
  await expect(orcaPage.locator('.terminal-copy-mode .xterm-accessibility-tree')).toContainText(
    'alpha.beta'
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('copy-mode-vim-selection.png') })
  expect(await readTerminalPtyWrites(electronApp)).toEqual([])
})

test('logical-line motions cross soft wraps, preserve desired columns and keep wide characters whole', async ({
  orcaPage,
  electronApp
}) => {
  const tabId = await resolveActiveTabId(orcaPage)
  const cols = await orcaPage.evaluate(
    (tabId) =>
      tabId ? (window.__paneManagers?.get(tabId)?.getActivePane()?.terminal.cols ?? 0) : 0,
    tabId
  )
  expect(cols).toBeGreaterThan(12)
  await seedCopyModeScreen(orcaPage, `  ${'a'.repeat(cols + 4)}中  \r\nshort`)
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  const grid = await readCopyModeGridGeometry(orcaPage)
  const extra = cols - grid.cols
  const steps: [string, number, number][] = [
    ['$', 1, extra + 9],
    ['g _', 1, extra + 6],
    ['0', 0, 0],
    ['j', 2, 0],
    ['k', 0, 0],
    ['$', 1, extra + 9],
    ['j', 2, 4],
    ['k', 1, extra + 9],
    ['0', 0, 0],
    ['^', 0, 2],
    ['e', 1, extra + 5],
    ['w', 1, extra + 6],
    ['b', 0, 2],
    ['W', 2, 0],
    ['B', 0, 2],
    ['E', 1, extra + 6]
  ]
  for (const [keys, row, column] of steps) {
    await pressCopyMotion(orcaPage, keys)
    await expectCopyCursorCell(orcaPage, row, column)
  }
  await pressCopyMotion(orcaPage, '$ v g _ y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('中  ')
  await pressCopyMotion(orcaPage, 'v 0 v $ y')
  await expect.poll(() => copiedModeText(electronApp)).toBe(`  ${'a'.repeat(cols + 4)}中  `)
  await pressCopyMotion(orcaPage, 'q')
  await seedCopyModeScreen(
    orcaPage,
    `${'a'.repeat(grid.cols - 1)}中Z\r\n${'q'.repeat(grid.cols + 2)}`
  )
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await pressCopyMotion(orcaPage, '$ h j')
  await expectCopyCursorCell(orcaPage, 2, grid.cols - 1)
  await pressCopyMotion(orcaPage, 'k')
  await expectCopyCursorCell(orcaPage, 1, 0)
  await pressCopyMotion(orcaPage, 'v y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('中')
})

test('half-page motions work in both directions and clamp at retained history boundaries', async ({
  orcaPage,
  electronApp
}) => {
  const lines = Array.from({ length: 200 }, (_, index) => `ROW_${index}`)
  await seedCopyModeScreen(orcaPage, lines.join('\r\n'))
  const tabId = await resolveActiveTabId(orcaPage)
  const geometry = await orcaPage.evaluate((tabId) => {
    const terminal = tabId ? window.__paneManagers?.get(tabId)?.getActivePane()?.terminal : null
    if (!terminal) {
      throw new Error('No terminal for half-page fixture')
    }
    return {
      row: terminal.buffer.active.baseY + terminal.buffer.active.cursorY
    }
  }, tabId)
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  const half = Math.max(1, Math.floor((await readCopyModeGridGeometry(orcaPage)).rows / 2))
  await pressCopyMotion(orcaPage, 'Control+d 0 v $ y')
  await expect
    .poll(() => copiedModeText(electronApp))
    .toBe(lines[Math.min(199, geometry.row + half)])
  await pressCopyMotion(orcaPage, 'v Control+u 0 v $ y')
  await expect.poll(() => copiedModeText(electronApp)).toBe(lines[geometry.row])
  await pressCopyMotion(orcaPage, 'v')
  for (let index = 0; index < 20; index += 1) {
    await pressCopyMotion(orcaPage, 'Control+u')
  }
  await pressCopyMotion(orcaPage, '0 v $ y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('ROW_0')
  await pressCopyMotion(orcaPage, 'v')
  for (let index = 0; index < 20; index += 1) {
    await pressCopyMotion(orcaPage, 'Control+d')
  }
  await pressCopyMotion(orcaPage, '0 v $ y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('ROW_199')
})

test('all new motions can be rebound while old single-key configurations keep their controls', async ({
  orcaPage,
  electronApp
}) => {
  await configureCopyMode(orcaPage, {
    copyMode: {
      exitOnCopy: false,
      bindings: {
        lineStart: ['Home'],
        lineEnd: ['End'],
        firstNonBlank: ['Alt+H'],
        lastNonBlank: ['Alt+L'],
        wordForward: ['Alt+W'],
        wordBackward: ['Alt+B'],
        wordEnd: ['Alt+E'],
        previousWordEnd: ['Alt+Shift+E'],
        bigWordForward: ['Alt+N'],
        bigWordBackward: ['Alt+P'],
        bigWordEnd: ['Alt+M'],
        previousBigWordEnd: ['Alt+Shift+M'],
        halfPageUp: ['PageUp'],
        halfPageDown: ['PageDown'],
        up: ['w']
      }
    }
  })
  const tabId = await resolveActiveTabId(orcaPage)
  const rows = await orcaPage.evaluate(
    (tabId) =>
      tabId ? (window.__paneManagers?.get(tabId)?.getActivePane()?.terminal.rows ?? 0) : 0,
    tabId
  )
  const lines = Array.from({ length: rows }, (_, index) => `MOTION_ROW_${index}`)
  lines[0] = '  alpha.beta  gamma   '
  lines[1] = 'next'
  await seedCopyModeScreen(orcaPage, lines.join('\r\n'))
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  const steps: [string, number][] = [
    ['Alt+H', 2],
    ['End', 21],
    ['Alt+L', 18],
    ['Home', 0],
    ['Alt+W', 2],
    ['Alt+W', 7],
    ['Alt+B', 2],
    ['Alt+E', 6],
    ['Alt+E', 7],
    ['Alt+Shift+E', 6],
    ['Home', 0],
    ['Alt+N', 2],
    ['Alt+N', 14],
    ['Alt+P', 2],
    ['Alt+M', 11],
    ['Alt+M', 18],
    ['Alt+Shift+M', 11]
  ]
  for (const [keys, column] of steps) {
    await pressCopyMotion(orcaPage, keys)
    await expectCopyCursorCell(orcaPage, 0, column)
  }
  await pressCopyMotion(orcaPage, 'Home j w')
  await expectCopyCursorCell(orcaPage, 0, 0)
  const half = Math.max(1, Math.floor((await readCopyModeGridGeometry(orcaPage)).rows / 2))
  await pressCopyMotion(orcaPage, 'PageDown Home v End y')
  await expect.poll(() => copiedModeText(electronApp)).toBe(lines[half])
  await pressCopyMotion(orcaPage, 'v Home PageUp')
  await expectCopyCursorCell(orcaPage, 0, 0)
  await pressCopyMotion(orcaPage, 'v End y')
  await expect.poll(() => copiedModeText(electronApp)).toBe('  alpha.beta  gamma   ')
})

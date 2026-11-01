import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { focusActiveTerminalInput, getTerminalContent } from './terminal'
import { quotePosixShell } from '../../../src/shared/shell-argument-quoting'

export async function openTerminalWorkspaceRootLink(
  page: Page,
  testInfo: TestInfo,
  rootPath: string,
  /** `open` Ctrl/Cmd-clicks, which opens a file link directly instead of its actions menu. */
  click: 'actions' | 'open' = 'actions'
): Promise<{ x: number; y: number }> {
  await focusActiveTerminalInput(page)
  const readyMarker = `ROOT_LINK_PRINTED_${Date.now()}`
  await page.keyboard.insertText(
    String.raw`printf '\n%s\n%s\n' ${quotePosixShell(rootPath)} ${quotePosixShell(readyMarker)}`
  )
  await page.keyboard.press('Enter')
  await expect
    .poll(() => getTerminalContent(page, 12000))
    .toMatch(new RegExp(String.raw`(?:^|\r?\n)${readyMarker}\r?\n`))
  const target: { current: { x: number; y: number } | null } = { current: null }
  await expect
    .poll(async () => {
      target.current = await page.evaluate((needle) => {
        const s = window.__store?.getState()
        const tabId = s?.activeTabId
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
        const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
        if (!pane || !screen) {
          return null
        }
        const buffer = pane.terminal.buffer.active
        const visibleCells = Array.from({ length: pane.terminal.rows }, (_, row) =>
          (buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? '').padEnd(
            pane.terminal.cols
          )
        ).join('')
        let start = visibleCells.indexOf(needle)
        while (
          start !== -1 &&
          (!/\s/.test(visibleCells[start - 1] ?? ' ') ||
            !/\s/.test(visibleCells[start + needle.length] ?? ' '))
        ) {
          start = visibleCells.indexOf(needle, start + 1)
        }
        if (start === -1) {
          return null
        }
        const center = start + Math.floor(needle.length / 2)
        const row = Math.floor(center / pane.terminal.cols)
        const column = center % pane.terminal.cols
        const rect = screen.getBoundingClientRect()
        return {
          x: rect.left + (column + 0.5) * (rect.width / pane.terminal.cols),
          y: rect.top + (row + 0.5) * (rect.height / pane.terminal.rows)
        }
      }, rootPath)
      return target.current !== null
    })
    .toBe(true)
  if (!target.current) {
    throw new Error('Missing actual printed terminal link')
  }
  await page.mouse.move(target.current.x, target.current.y)
  await expect(
    page
      .locator('.pane-link-tooltip:visible')
      .filter({ hasText: click === 'actions' ? `${rootPath} (Click for actions` : `${rootPath} (` })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('managed-terminal-root-link-hover.png') })
  if (click === 'actions') {
    await page.mouse.click(target.current.x, target.current.y)
    return target.current
  }
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier)
  try {
    await page.mouse.click(target.current.x, target.current.y)
  } finally {
    await page.keyboard.up(modifier)
  }
  return target.current
}

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

type TerminalGeometry = {
  cellWidth: number
  cellHeight: number
  cols: number
  rows: number
  scrollbarWidth: number
  pane: { top: number; right: number; bottom: number; left: number; width: number; height: number }
  terminal: { top: number; right: number; bottom: number; left: number }
  screen: {
    top: number
    right: number
    bottom: number
    left: number
    width: number
    height: number
  }
}

const FIRST_PADDING = { x: 11, y: 7 }
const SECOND_PADDING = { x: 17, y: 13 }
const TARGET_COLS = 70
const TARGET_ROWS = 20
const MIN_REMAINDER = 2

async function readTerminalGeometry(page: Page): Promise<TerminalGeometry> {
  return page.evaluate(() => {
    const terminalElement = document.querySelector<HTMLElement>('.pane .xterm')
    const paneElement = terminalElement?.closest<HTMLElement>('.pane')
    const screenElement = terminalElement?.querySelector<HTMLElement>('.xterm-screen')
    const manager = [...(window.__paneManagers?.values() ?? [])].find((candidate) =>
      candidate.getPanes().some((pane) => pane.container === paneElement)
    )
    const pane = manager?.getPanes().find((candidate) => candidate.container === paneElement)
    const cell = pane?.terminal.dimensions?.css.cell
    if (!terminalElement || !paneElement || !screenElement || !pane || !cell) {
      throw new Error('Active terminal geometry is unavailable')
    }
    const paneRect = paneElement.getBoundingClientRect()
    const terminalRect = terminalElement.getBoundingClientRect()
    const screenRect = screenElement.getBoundingClientRect()
    return {
      cellWidth: cell.width,
      cellHeight: cell.height,
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      scrollbarWidth: pane.terminal.options.scrollbar?.width ?? 14,
      pane: {
        top: paneRect.top,
        right: paneRect.right,
        bottom: paneRect.bottom,
        left: paneRect.left,
        width: paneRect.width,
        height: paneRect.height
      },
      terminal: {
        top: terminalRect.top,
        right: terminalRect.right,
        bottom: terminalRect.bottom,
        left: terminalRect.left
      },
      screen: {
        top: screenRect.top,
        right: screenRect.right,
        bottom: screenRect.bottom,
        left: screenRect.left,
        width: screenRect.width,
        height: screenRect.height
      }
    }
  })
}

function findNonDivisibleSize(cellSize: number, cells: number, chrome: number): number {
  const floor = Math.ceil(cellSize * cells + chrome)
  for (let size = floor; size < floor + Math.ceil(cellSize); size += 1) {
    const available = size - chrome
    const remainder = available - Math.floor(available / cellSize) * cellSize
    if (remainder > MIN_REMAINDER && remainder < cellSize - MIN_REMAINDER) {
      return size
    }
  }
  throw new Error(`Could not force a non-divisible ${cellSize}px cell geometry`)
}

async function applyPaddingAndPaneSize(
  page: Page,
  padding: { x: number; y: number },
  size: { width: number; height: number }
): Promise<void> {
  await page.evaluate(
    async ({ nextPadding, nextSize }) => {
      const store = window.__store
      const terminal = document.querySelector<HTMLElement>('.pane .xterm')
      const pane = terminal?.closest<HTMLElement>('.pane')
      if (!store || !pane) {
        throw new Error('Terminal settings surface is unavailable')
      }
      await store.getState().updateSettings({
        terminalPaddingX: nextPadding.x,
        terminalPaddingY: nextPadding.y
      })
      pane.style.setProperty('width', `${nextSize.width}px`, 'important')
      pane.style.setProperty('height', `${nextSize.height}px`, 'important')
    },
    { nextPadding: padding, nextSize: size }
  )

  await page.waitForFunction(
    ({ expectedPadding, expectedSize }) => {
      const store = window.__store
      const terminal = document.querySelector<HTMLElement>('.pane .xterm')
      const pane = terminal?.closest<HTMLElement>('.pane')
      if (!store || !pane) {
        return false
      }
      const settings = store.getState().settings
      const rect = pane.getBoundingClientRect()
      return (
        settings?.terminalPaddingX === expectedPadding.x &&
        settings?.terminalPaddingY === expectedPadding.y &&
        Math.abs(rect.width - expectedSize.width) < 0.5 &&
        Math.abs(rect.height - expectedSize.height) < 0.5
      )
    },
    { expectedPadding: padding, expectedSize: size }
  )

  await page.evaluate(() => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes()) {
        pane.fitAddon.fit()
      }
    }
  })
  await page.waitForTimeout(100)
}

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(0.75)
}

function assertFourEdgeGeometry(
  geometry: TerminalGeometry,
  padding: { x: number; y: number }
): { horizontalRemainder: number; verticalRemainder: number } {
  const verticalRemainder = geometry.pane.height - padding.y * 2 - geometry.screen.height

  // The old layout only exposed its trailing gap when cell fitting left a remainder.
  expect(verticalRemainder).toBeGreaterThan(MIN_REMAINDER)
  expect(verticalRemainder).toBeLessThan(geometry.cellHeight)

  expect({
    left: geometry.terminal.left - geometry.pane.left,
    top: geometry.terminal.top - geometry.pane.top,
    right: geometry.pane.right - geometry.terminal.right,
    bottom: geometry.pane.bottom - geometry.terminal.bottom
  }).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })

  const horizontalRemainder =
    geometry.pane.width - padding.x * 2 - geometry.scrollbarWidth - geometry.screen.width

  expect(horizontalRemainder).toBeGreaterThan(0)
  expect(horizontalRemainder).toBeLessThan(geometry.cellWidth)

  expectClose(geometry.screen.left - geometry.pane.left, padding.x)
  expectClose(geometry.screen.top - geometry.pane.top, padding.y)
  expectClose(
    geometry.pane.right - geometry.screen.right,
    padding.x + geometry.scrollbarWidth + horizontalRemainder
  )
  expectClose(geometry.pane.bottom - geometry.screen.bottom, padding.y + verticalRemainder)

  return { horizontalRemainder, verticalRemainder }
}

test.describe('terminal padding geometry', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
  })

  // #13252: the old start-edge margin left the grid flush right/bottom. The
  // #14583 re-land was reverted, so this guard checks geometry, not its paint mechanism.
  test('keeps configured padding on all four edges with a forced cell remainder @terminal-rendering-golden', async ({
    orcaPage
  }) => {
    const baseline = await readTerminalGeometry(orcaPage)
    const firstSize = {
      width: findNonDivisibleSize(
        baseline.cellWidth,
        TARGET_COLS,
        FIRST_PADDING.x * 2 + baseline.scrollbarWidth
      ),
      height: findNonDivisibleSize(baseline.cellHeight, TARGET_ROWS, FIRST_PADDING.y * 2)
    }

    await applyPaddingAndPaneSize(orcaPage, FIRST_PADDING, firstSize)
    const first = await readTerminalGeometry(orcaPage)
    const firstRemainders = assertFourEdgeGeometry(first, FIRST_PADDING)

    // Keep usable dimensions constant while changing both setting values.
    const secondSize = {
      width: firstSize.width + (SECOND_PADDING.x - FIRST_PADDING.x) * 2,
      height: firstSize.height + (SECOND_PADDING.y - FIRST_PADDING.y) * 2
    }
    await applyPaddingAndPaneSize(orcaPage, SECOND_PADDING, secondSize)
    const second = await readTerminalGeometry(orcaPage)
    const secondRemainders = assertFourEdgeGeometry(second, SECOND_PADDING)

    expect(second.cols).toBe(first.cols)
    expect(second.rows).toBe(first.rows)
    expectClose(secondRemainders.horizontalRemainder, firstRemainders.horizontalRemainder)
    expectClose(secondRemainders.verticalRemainder, firstRemainders.verticalRemainder)
  })
})

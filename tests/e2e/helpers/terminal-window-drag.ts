import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

export type Point = { x: number; y: number }

function warpCursor(point: Point): void {
  execFileSync('/usr/bin/swift', [
    '-e',
    `import CoreGraphics\nCGWarpMouseCursorPosition(CGPoint(x: ${Math.round(point.x)}, y: ${Math.round(point.y)}))`
  ])
}

export async function dragTerminalTabOutside(
  app: ElectronApplication,
  page: Page,
  tabId: string,
  targetPoint: Point,
  direction: 'left' | 'right'
): Promise<void> {
  await page.bringToFront()
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).first()
  await expect(tab).toBeVisible()
  const initialBox = await tab.boundingBox()
  if (!initialBox) {
    throw new Error('terminal tab has no bounding box')
  }
  const position = { x: Math.min(30, initialBox.width / 2), y: initialBox.height / 2 }
  await tab.hover({ position })
  const box = await tab.boundingBox()
  if (!box) {
    throw new Error('terminal tab disappeared after hover')
  }
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  const start = { x: box.x + position.x, y: box.y + position.y }
  const outsideX = direction === 'left' ? -80 : viewport.width + 80

  expect(
    await page.evaluate(
      (point) =>
        document
          .elementFromPoint(point.x, point.y)
          ?.closest('[data-testid="sortable-tab"]')
          ?.getAttribute('data-tab-id') ?? null,
      start
    )
  ).toBe(tabId)

  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + (direction === 'left' ? -20 : 20), start.y, { steps: 3 })
  await page.mouse.move(outsideX, Math.min(start.y + 20, viewport.height - 20), { steps: 10 })
  const cursorPoint = { x: Math.round(targetPoint.x), y: Math.round(targetPoint.y) }
  warpCursor(cursorPoint)
  await expect
    .poll(() => app.evaluate(({ screen }) => screen.getCursorScreenPoint()))
    .toEqual(cursorPoint)
  await page.mouse.up()
}

export async function getTerminalTabSnapshot(page: Page, tabId: string) {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      return null
    }
    const tab = Object.values(state.tabsByWorktree)
      .flat()
      .find((candidate) => candidate.id === id)
    const layout = state.terminalLayoutsByTabId[id]
    return {
      exists: Boolean(tab),
      ptyIds: [
        ...new Set([
          ...Object.values(layout?.ptyIdsByLeafId ?? {}),
          ...(state.ptyIdsByTabId[id] ?? []),
          ...(tab?.ptyId ? [tab.ptyId] : [])
        ])
      ].filter(Boolean)
    }
  }, tabId)
}

export async function persistActiveWorkspaceIdentity(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('workspace store missing')
    }
    await window.api.session.patch({
      activeRepoId: state.activeRepoId,
      activeWorktreeId: state.activeWorktreeId,
      activeWorkspaceKey: state.activeWorkspaceKey,
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId
    })
  })
}

export async function clickTerminalTab(page: Page, tabId: string): Promise<void> {
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).first()
  await expect(tab).toBeVisible()
  await tab.click()
}

export async function positionSourceWindowForDetach(
  app: ElectronApplication,
  sourceWindowId: number
): Promise<Point> {
  return app.evaluate(({ BrowserWindow, screen }, sourceId) => {
    const source = BrowserWindow.fromId(sourceId)
    if (!source) {
      throw new Error('control window missing')
    }
    const area = screen.getPrimaryDisplay().workArea
    source.setBounds({
      x: area.x + 20,
      y: area.y + 20,
      width: Math.min(760, Math.floor(area.width * 0.55)),
      height: Math.min(700, area.height - 40)
    })
    return { x: area.x + area.width - 30, y: area.y + Math.min(300, area.height - 30) }
  }, sourceWindowId)
}

export async function positionWindowsForReturn(
  app: ElectronApplication,
  ids: { control: number; secondary: number }
): Promise<Point> {
  return app.evaluate(({ BrowserWindow, screen }, windowIds) => {
    const controlWindow = BrowserWindow.fromId(windowIds.control)
    const secondaryWindow = BrowserWindow.fromId(windowIds.secondary)
    if (!controlWindow || !secondaryWindow) {
      throw new Error('transfer windows missing')
    }
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.floor((area.width - 80) / 2)
    const height = Math.min(700, area.height - 40)
    controlWindow.setBounds({ x: area.x + 20, y: area.y + 20, width, height })
    secondaryWindow.setBounds({ x: area.x + width + 60, y: area.y + 20, width, height })
    const bounds = controlWindow.getBounds()
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  }, ids)
}

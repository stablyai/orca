import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId
} from './helpers/terminal'

type Point = { x: number; y: number }

function warpCursor(point: Point): void {
  execFileSync('/usr/bin/swift', [
    '-e',
    `import CoreGraphics\nCGWarpMouseCursorPosition(CGPoint(x: ${Math.round(point.x)}, y: ${Math.round(point.y)}))`
  ])
}

async function dragTabOutside(
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
  const position = {
    x: Math.min(30, initialBox.width / 2),
    y: initialBox.height / 2
  }
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
  warpCursor(targetPoint)
  await expect
    .poll(() => app.evaluate(({ screen }) => screen.getCursorScreenPoint()))
    .toEqual(targetPoint)
  await page.mouse.up()
}

async function getTabSnapshot(page: Page, tabId: string) {
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

test.describe.configure({ mode: 'serial' })

test('detaches and reattaches one live terminal tab without replacing its PTY @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform !== 'darwin', 'live cursor warp uses macOS CoreGraphics')
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const tabId = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      return null
    }
    state.setSidebarOpen(false)
    state.setRightSidebarOpen(false)
    const tab = state.createTab(state.activeWorktreeId)
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  })
  expect(tabId).not.toBeNull()
  await expect(
    orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).first()
  ).toBeVisible()
  const originalPtyId = await waitForActivePanePtyId(orcaPage, 30_000)

  const token = `detach_${Date.now()}`
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.type(`export ORCA_DETACH_TOKEN=${token}`)
  await orcaPage.keyboard.press('Enter')

  const firstGeometry = await electronApp.evaluate(
    ({ BrowserWindow, screen }, sourceId) => {
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
      return {
        targetPoint: { x: area.x + area.width - 30, y: area.y + Math.min(300, area.height - 30) }
      }
    },
    (await orcaPage.evaluate(() => window.api.terminalWindow.getContext())).windowId
  )

  await dragTabOutside(electronApp, orcaPage, tabId!, firstGeometry.targetPoint, 'right')
  await expect.poll(() => electronApp.windows().length, { timeout: 30_000 }).toBe(2)

  const windows = await Promise.all(
    electronApp.windows().map(async (page) => {
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      return { page, context: await page.evaluate(() => window.api.terminalWindow.getContext()) }
    })
  )
  const control = windows.find(({ context }) => context.role === 'control')
  const secondary = windows.find(({ context }) => context.role === 'secondary')
  expect(control).toBeTruthy()
  expect(secondary).toBeTruthy()
  await expect.poll(() => getTabSnapshot(control!.page, tabId!)).toMatchObject({ exists: false })
  await expect
    .poll(() => getTabSnapshot(secondary!.page, tabId!))
    .toMatchObject({
      exists: true,
      ptyIds: expect.arrayContaining([originalPtyId])
    })
  expect(await waitForActivePanePtyId(secondary!.page, 30_000)).toBe(originalPtyId)
  await secondary!.page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setSidebarOpen(false)
    state?.setRightSidebarOpen(false)
  })

  const afterDetachMarker = `__AFTER_DETACH__:${token}`
  await focusActiveTerminalInput(secondary!.page)
  await secondary!.page.keyboard.type(`printf '__AFTER_DETACH__:%s\\n' "$ORCA_DETACH_TOKEN"`)
  await secondary!.page.keyboard.press('Enter')
  await expect
    .poll(() => getTerminalContent(secondary!.page), { timeout: 15_000 })
    .toContain(afterDetachMarker)

  const backGeometry = await electronApp.evaluate(
    ({ BrowserWindow, screen }, ids) => {
      const controlWindow = BrowserWindow.fromId(ids.control)
      const secondaryWindow = BrowserWindow.fromId(ids.secondary)
      if (!controlWindow || !secondaryWindow) {
        throw new Error('transfer windows missing')
      }
      const area = screen.getPrimaryDisplay().workArea
      const width = Math.floor((area.width - 80) / 2)
      const height = Math.min(700, area.height - 40)
      controlWindow.setBounds({ x: area.x + 20, y: area.y + 20, width, height })
      secondaryWindow.setBounds({ x: area.x + width + 60, y: area.y + 20, width, height })
      const bounds = controlWindow.getBounds()
      return { targetPoint: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } }
    },
    { control: control!.context.windowId, secondary: secondary!.context.windowId }
  )

  await dragTabOutside(electronApp, secondary!.page, tabId!, backGeometry.targetPoint, 'left')
  await expect.poll(() => electronApp.windows().length, { timeout: 30_000 }).toBe(1)
  await expect
    .poll(() => getTabSnapshot(control!.page, tabId!))
    .toMatchObject({
      exists: true,
      ptyIds: expect.arrayContaining([originalPtyId])
    })
  expect(await waitForActivePanePtyId(control!.page, 30_000)).toBe(originalPtyId)

  const afterReturnMarker = `__AFTER_RETURN__:${token}`
  await focusActiveTerminalInput(control!.page)
  await control!.page.keyboard.type(`printf '__AFTER_RETURN__:%s\\n' "$ORCA_DETACH_TOKEN"`)
  await control!.page.keyboard.press('Enter')
  await expect
    .poll(() => getTerminalContent(control!.page), { timeout: 15_000 })
    .toContain(afterReturnMarker)

  console.log(
    JSON.stringify({ tabId, ptyId: originalPtyId, token, afterDetachMarker, afterReturnMarker })
  )
})

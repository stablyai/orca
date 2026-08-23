import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { TerminalWindowContext } from '../../src/shared/terminal-window-transfer'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  clickTerminalTab,
  dragTerminalTabOutside,
  positionSourceWindowForDetach
} from './helpers/terminal-window-drag'

type OrcaWindow = {
  page: Page
  context: TerminalWindowContext
}

async function prepareTerminalPair(page: Page): Promise<{
  baseTabId: string
  basePtyId: string
  detachedTabId: string
  detachedPtyId: string
}> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const baseTabId = await page.evaluate(() => window.__store?.getState().activeTabId ?? null)
  if (!baseTabId) {
    throw new Error('base terminal tab missing')
  }
  const basePtyId = await waitForActivePanePtyId(page, 30_000)
  const detachedTabId = await page.evaluate(() => {
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
  if (!detachedTabId) {
    throw new Error('detachable terminal tab missing')
  }
  await expect(
    page.locator(`[data-testid="sortable-tab"][data-tab-id="${detachedTabId}"]`).first()
  ).toBeVisible()
  const detachedPtyId = await waitForActivePanePtyId(page, 30_000)
  return { baseTabId, basePtyId, detachedTabId, detachedPtyId }
}

async function readOrcaWindows(app: ElectronApplication): Promise<OrcaWindow[]> {
  return Promise.all(
    app.windows().map(async (page) => {
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      const context = await page.evaluate(() => window.api.terminalWindow.getContext())
      return { page, context } as OrcaWindow
    })
  )
}

async function detachTerminalPair(app: ElectronApplication, page: Page, tabId: string) {
  const source = await page.evaluate(() => window.api.terminalWindow.getContext())
  const point = await positionSourceWindowForDetach(app, source.windowId)
  await dragTerminalTabOutside(app, page, tabId, point, 'right')
  await expect.poll(() => app.windows().length, { timeout: 30_000 }).toBe(2)
  const windows = await readOrcaWindows(app)
  const control = windows.find(({ context }) => context.role === 'control')
  const secondary = windows.find(({ context }) => context.role === 'secondary')
  if (!control || !secondary) {
    throw new Error('detached Orca window roles missing')
  }
  return { control, secondary }
}

async function closeWindow(app: ElectronApplication, windowId: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), windowId)
  await expect.poll(() => app.windows().length, { timeout: 30_000 }).toBe(1)
}

async function assertTerminalInput(page: Page, marker: string): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.type(`printf '${marker}\\n'`)
  await page.keyboard.press('Enter')
  await expect.poll(() => getTerminalContent(page), { timeout: 15_000 }).toContain(marker)
}

test.describe.configure({ mode: 'serial' })

test('detaches a live terminal through the hidden CDP renderer', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform !== 'darwin', 'live cursor warp uses macOS CoreGraphics')
  const terminal = await prepareTerminalPair(orcaPage)
  const marker = `__HEADLESS_DETACH__${Date.now()}`
  await execInTerminal(orcaPage, terminal.detachedPtyId, `printf '${marker}\\n'`)
  await waitForTerminalOutput(orcaPage, marker, 15_000)

  const { secondary } = await detachTerminalPair(electronApp, orcaPage, terminal.detachedTabId)

  await expect(
    secondary.page.locator(`[data-testid="sortable-tab"][data-tab-id="${terminal.detachedTabId}"]`)
  ).toBeVisible()
  expect(await waitForActivePanePtyId(secondary.page, 30_000)).toBe(terminal.detachedPtyId)
  await expect.poll(() => getTerminalContent(secondary.page), { timeout: 15_000 }).toContain(marker)
})

test('closing the secondary leaves the control terminal live @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform !== 'darwin', 'live cursor warp uses macOS CoreGraphics')
  const terminal = await prepareTerminalPair(orcaPage)
  const { control, secondary } = await detachTerminalPair(
    electronApp,
    orcaPage,
    terminal.detachedTabId
  )

  await closeWindow(electronApp, secondary.context.windowId)
  await clickTerminalTab(control.page, terminal.baseTabId)
  expect(await waitForActivePanePtyId(control.page, 30_000)).toBe(terminal.basePtyId)
  await assertTerminalInput(control.page, `__SECONDARY_FIRST__${Date.now()}`)
})

test('closing the control promotes the secondary without replacing its PTY @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform !== 'darwin', 'live cursor warp uses macOS CoreGraphics')
  const terminal = await prepareTerminalPair(orcaPage)
  const { control } = await detachTerminalPair(electronApp, orcaPage, terminal.detachedTabId)

  await closeWindow(electronApp, control.context.windowId)
  const promoted = electronApp.windows()[0]
  await promoted.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await expect
    .poll(() => promoted.evaluate(() => window.api.terminalWindow.getContext()))
    .toMatchObject({ role: 'control' })
  await clickTerminalTab(promoted, terminal.detachedTabId)
  expect(await waitForActivePanePtyId(promoted, 30_000)).toBe(terminal.detachedPtyId)
  await assertTerminalInput(promoted, `__CONTROL_FIRST__${Date.now()}`)
})

test('quit merges detached windows into one control with live scrollback @headful', async ({
  testRepoPath
}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'live cursor warp uses macOS CoreGraphics')
  test.setTimeout(300_000)
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    const terminal = await prepareTerminalPair(first.page)
    const marker = `__DETACHED_RESTART__${Date.now()}`
    await execInTerminal(first.page, terminal.detachedPtyId, `printf '${marker}\\n'`)
    await waitForTerminalOutput(first.page, marker, 15_000)
    const { secondary } = await detachTerminalPair(first.app, first.page, terminal.detachedTabId)
    await expect
      .poll(() => getTerminalContent(secondary.page), { timeout: 15_000 })
      .toContain(marker)

    await session.close(first.app)
    firstApp = null
    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)

    await expect.poll(() => second.app.windows().length, { timeout: 30_000 }).toBe(1)
    await expect
      .poll(() => second.page.evaluate(() => window.api.terminalWindow.getContext()))
      .toMatchObject({ role: 'control' })
    await clickTerminalTab(second.page, terminal.detachedTabId)
    expect(await waitForActivePanePtyId(second.page, 30_000)).toBe(terminal.detachedPtyId)
    await expect
      .poll(() => getTerminalContent(second.page, 40_000), { timeout: 20_000 })
      .toContain(marker)
    await assertTerminalInput(second.page, `__DETACHED_RESTART_LIVE__${Date.now()}`)
  } finally {
    for (const app of [secondApp, firstApp]) {
      if (app) {
        await session.close(app).catch(() => undefined)
      }
    }
    await session.dispose()
  }
})

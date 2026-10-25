import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { splitMarkerEchoCommand } from './terminal-marker-echo-command'
import {
  registeredNativeBrowserGuest,
  nativeDesktopPages as nativePages
} from './helpers/native-desktop-window'

async function openWindow(
  app: ElectronApplication,
  host: Page,
  worktreeId?: string
): Promise<Page> {
  const known = new Set(app.windows())
  expect(
    await host.evaluate(
      (id) => window.api.ui.openRuntimeClientWindow(id ? { worktreeId: id } : undefined),
      worktreeId
    )
  ).toEqual({ ok: true })
  await expect
    .poll(() => nativePages(app).some((page) => !known.has(page)), { timeout: 30_000 })
    .toBe(true)
  const page = nativePages(app).find((candidate) => !known.has(candidate))
  if (!page) {
    throw new Error('New native window disappeared')
  }
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await waitForSessionReady(page)
  expect(await page.evaluate(() => window.__ORCA_NATIVE_WINDOW_ID__)).toBeTruthy()
  await expect(page.locator('[data-worktree-sidebar]')).toBeVisible({ timeout: 30_000 })
  return page
}

async function expectWorkspace(page: Page, id: string): Promise<void> {
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    id,
    { timeout: 30_000 }
  )
}

async function marker(page: Page, prefix: string, suffix: string): Promise<void> {
  await ensureTerminalVisible(page, 30_000)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForActivePanePtyId(page, 30_000)
  await focusActiveTerminalInput(page)
  await page.keyboard.type(splitMarkerEchoCommand(prefix, suffix))
  await page.keyboard.press('Enter')
  await waitForTerminalOutput(page, `${prefix}${suffix}`, 30_000)
}

async function closeWindow(app: ElectronApplication, page: Page): Promise<void> {
  const window = await app.browserWindow(page)
  await window.evaluate((window) => window.close())
  await expect.poll(() => page.isClosed(), { timeout: 15_000 }).toBe(true)
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const target = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: target })
  await testInfo.attach(name, { path: target, contentType: 'image/png' })
}

test('four complete native windows keep terminals and workspace selections after closing the first', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  const ids = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    return {
      a: state?.activeWorktreeId,
      b: state?.allWorktrees().find((worktree) => worktree.branch === 'refs/heads/e2e-secondary')
        ?.id
    }
  })
  if (!ids.a || !ids.b) {
    throw new Error('Missing seeded workspaces')
  }
  const second = await openWindow(electronApp, orcaPage, ids.b)
  const third = await openWindow(electronApp, second, ids.a)
  const fourth = await openWindow(electronApp, third, ids.b)
  const pages = [orcaPage, second, third, fourth]
  const windowIds = await Promise.all(
    pages.map((page) => page.evaluate(() => window.__ORCA_NATIVE_WINDOW_ID__))
  )
  expect(new Set(windowIds).size).toBe(4)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  await expectWorkspace(orcaPage, ids.a)
  await expectWorkspace(second, ids.b)
  await expectWorkspace(third, ids.a)
  await expectWorkspace(fourth, ids.b)
  await marker(orcaPage, 'native-first-', 'ready')
  await marker(second, 'native-second-', 'ready')
  await marker(third, 'native-third-', 'ready')
  await marker(fourth, 'native-fourth-', 'ready')
  await screenshot(fourth, testInfo, 'fourth-native-window')
  await closeWindow(electronApp, orcaPage)
  await marker(second, 'native-second-', 'after-first-close')
  await marker(third, 'native-third-', 'after-first-close')
  await closeWindow(electronApp, third)
  await marker(fourth, 'native-fourth-', 'after-peer-close')
  await expectWorkspace(second, ids.b)
  await screenshot(second, testInfo, 'surviving-native-window')
  const fifth = await openWindow(electronApp, second, ids.a)
  await expectWorkspace(fifth, ids.a)
  await marker(fifth, 'native-reopened-', 'ready')
})

test('restores only open native windows with their own selections and bounds', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const session = createRestartSession(testInfo)
  let activeApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    activeApp = first.app
    await waitForSessionReady(first.page)
    const primary = await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await expect
      .poll(
        () =>
          first.page.evaluate(async () => {
            const state = window.__store?.getState()
            for (const repo of state?.repos ?? []) {
              await state?.fetchWorktrees(repo.id)
            }
            return window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.branch === 'refs/heads/e2e-secondary')
          }),
        { timeout: 30_000 }
      )
      .toBe(true)
    const ids = await first.page.evaluate((a) => {
      const state = window.__store?.getState()
      return {
        a,
        b: state?.allWorktrees().find((worktree) => worktree.branch === 'refs/heads/e2e-secondary')
          ?.id
      }
    }, primary)
    if (!ids.a || !ids.b) {
      throw new Error('Missing restart workspaces')
    }
    const second = await openWindow(first.app, first.page, ids.b)
    const closed = await openWindow(first.app, second, ids.a)
    await closeWindow(first.app, closed)
    const secondWindow = await first.app.browserWindow(second)
    await secondWindow.evaluate((window) =>
      window.setBounds({ x: 90, y: 110, width: 1180, height: 820 })
    )
    const expectedBounds = await secondWindow.evaluate((window) => window.getBounds())
    const expected = await Promise.all(
      [first.page, second].map((page) =>
        page.evaluate(() => ({
          id: window.__ORCA_NATIVE_WINDOW_ID__,
          worktree: window.__store?.getState().activeWorktreeId
        }))
      )
    )
    await session.close(first.app)
    activeApp = null
    const restored = await session.launch()
    activeApp = restored.app
    await expect.poll(() => nativePages(restored.app).length, { timeout: 30_000 }).toBe(2)
    const restoredPages = nativePages(restored.app)
    for (const page of restoredPages) {
      await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      await waitForSessionReady(page)
    }
    await expect
      .poll(async () =>
        Promise.all(
          restoredPages.map((page) =>
            page.evaluate(() => ({
              id: window.__ORCA_NATIVE_WINDOW_ID__,
              worktree: window.__store?.getState().activeWorktreeId
            }))
          )
        )
      )
      .toEqual(expect.arrayContaining(expected))
    const secondId = expected[1]?.id
    let restoredSecond: Page | undefined
    for (const page of restoredPages) {
      if ((await page.evaluate(() => window.__ORCA_NATIVE_WINDOW_ID__)) === secondId) {
        restoredSecond = page
      }
    }
    if (!restoredSecond) {
      throw new Error('Second native window was not restored')
    }
    const restoredWindow = await restored.app.browserWindow(restoredSecond)
    const actualBounds = await restoredWindow.evaluate((window) => window.getBounds())
    expect(Math.abs(actualBounds.width - expectedBounds.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(actualBounds.height - expectedBounds.height)).toBeLessThanOrEqual(1)
    await marker(restoredSecond, 'native-restored-', 'ready')
    await screenshot(restoredSecond, testInfo, 'restored-native-window')
  } finally {
    if (activeApp) {
      await session.close(activeApp).catch(() => undefined)
    }
    await session.dispose()
  }
})

test('keeps a browser page usable in a surviving native window', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  const target = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tab = worktreeId
      ? state?.createBrowserTab(worktreeId, 'about:blank', { activate: true })
      : null
    return tab?.activePageId && worktreeId
      ? { tabId: tab.id, pageId: tab.activePageId, worktreeId }
      : null
  })
  if (!target) {
    throw new Error('Missing browser page')
  }
  const second = await openWindow(electronApp, orcaPage, target.worktreeId)
  await second.evaluate(({ tabId, worktreeId }) => {
    const state = window.__store?.getState()
    state?.setActiveTabType('browser', worktreeId)
    state?.setActiveBrowserTab(tabId, worktreeId)
  }, target)
  await expect
    .poll(() => registeredNativeBrowserGuest(second, target), { timeout: 30_000 })
    .toBe(true)
  await closeWindow(electronApp, orcaPage)
  await expect
    .poll(() => registeredNativeBrowserGuest(second, target), { timeout: 30_000 })
    .toBe(true)
  await screenshot(second, testInfo, 'surviving-browser-window')
})

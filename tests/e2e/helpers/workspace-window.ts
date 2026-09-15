import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { retryTransientMainEvaluate } from './electron-main-evaluate-retry'

export async function expectHiddenWorkspaceWindows(app: ElectronApplication): Promise<void> {
  expect(
    await retryTransientMainEvaluate(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      )
    )
  ).toBe(true)
}

export async function openWorkspaceWindow(
  app: ElectronApplication,
  action = 'New Window'
): Promise<Page> {
  const nextWindow = app.waitForEvent('window')
  await app.evaluate(({ app, BrowserWindow, Menu }, action) => {
    app.once('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false))
    const item = Menu.getApplicationMenu()!
      .items.find((item) => item.label === 'Window')!
      .submenu!.items.find((item) => item.label === action)!
    item.click(item, BrowserWindow.getAllWindows()[0]!, {} as never)
  }, action)
  const page = await nextWindow
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await expectHiddenWorkspaceWindows(app)
  return page
}

export async function browserViewIdForPage(page: Page, pageId: string): Promise<string> {
  await page.waitForFunction((remotePageId) => {
    const state = window.__store!.getState()
    return Object.values(state.browserPagesByWorkspace)
      .flat()
      .some(
        (page) => state.remoteBrowserPageHandlesByPageId[page.id]?.remotePageId === remotePageId
      )
  }, pageId)
  return page.evaluate((remotePageId) => {
    const state = window.__store!.getState()
    return Object.values(state.browserPagesByWorkspace)
      .flat()
      .find(
        (page) => state.remoteBrowserPageHandlesByPageId[page.id]?.remotePageId === remotePageId
      )!.workspaceId
  }, pageId)
}

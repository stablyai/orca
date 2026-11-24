import { writeFileSync } from 'node:fs'
import { test } from './desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from './desktop/renderer-probes/store'

for (const theme of ['light', 'dark'] as const) {
  test(`left tools rail leaves one content toolbar below the titlebar (${theme})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    await orcaPage.evaluate((theme) => {
      const store = window.__store
      if (!store) {
        throw new Error('Expected the E2E renderer store')
      }
      store.setState((state) => {
        if (!state.settings) {
          throw new Error('Expected settings to be loaded')
        }
        return {
          settings: { ...state.settings, theme, toolsSidebarPosition: 'left' },
          sidebarOpen: false,
          rightSidebarOpen: true,
          rightSidebarWidth: 220,
          rightSidebarTab: 'explorer'
        }
      })
    }, theme)

    const sidebar = orcaPage.locator('[data-tools-sidebar-side="left"]')
    const explorer = sidebar.locator('button[data-tools-sidebar-tab="explorer"]')
    const sourceControl = sidebar.locator('button[data-tools-sidebar-tab="source-control"]')
    await expect(explorer).toHaveAttribute('aria-current', 'page')
    await expect(sidebar.locator('[data-orca-explorer-shell]')).toBeVisible()
    await expect(sidebar.locator('.right-sidebar-header-drag')).toHaveCount(0)
    await expect(sidebar.locator('.right-sidebar-activity-strip')).toHaveCount(0)

    const explorerBounds = await explorer.boundingBox()
    const sourceControlBounds = await sourceControl.boundingBox()
    const contentBounds = await sidebar.locator('[data-orca-explorer-shell]').boundingBox()
    if (!explorerBounds || !sourceControlBounds || !contentBounds) {
      throw new Error('Expected a measurable tools sidebar')
    }
    expect(explorerBounds.width).toBeCloseTo(40, 1)
    expect(explorerBounds.x).toBeCloseTo(sourceControlBounds.x, 1)
    expect(sourceControlBounds.y).toBeGreaterThan(explorerBounds.y)
    const railAndDividerWidth = contentBounds.x - explorerBounds.x
    expect(railAndDividerWidth).toBeGreaterThanOrEqual(explorerBounds.width - 0.1)
    expect(railAndDividerWidth).toBeLessThanOrEqual(explorerBounds.width + 1)
    expect(contentBounds.y).toBeCloseTo(explorerBounds.y, 1)

    const sidebarBounds = await sidebar.boundingBox()
    if (!sidebarBounds) {
      throw new Error('Expected the tools sidebar to remain visible')
    }
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    try {
      const screenshot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: sidebarBounds.x, y: 0, width: sidebarBounds.width, height: 480, scale: 1 }
      })
      const screenshotPath = testInfo.outputPath('tools-sidebar-activity-rail.png')
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
      await testInfo.attach('Tools sidebar activity rail', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      await cdp.detach()
    }

    await sidebar.locator('button.sidebar-toggle').click()
    await expect(sidebar).toHaveClass(/overflow-hidden/)
    await expect(sidebar.locator('[data-orca-explorer-shell]')).toHaveCount(0)
  })
}

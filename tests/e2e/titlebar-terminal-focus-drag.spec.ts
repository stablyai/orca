import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const dragSurfaces = [
  '.titlebar',
  '.titlebar-left',
  '.right-sidebar-header-drag',
  '[data-terminal-focus-release-surface="true"]'
]

test('terminal focus keeps caption drag regions live and controls clickable', async ({
  orcaPage
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await orcaPage.evaluate(() => window.__store?.getState().setRightSidebarOpen(true))
  await expect(orcaPage.locator('.right-sidebar-header-drag:visible').first()).toBeVisible()

  const helper = orcaPage.locator('.xterm:visible .xterm-helper-textarea').first()
  await expect(helper).toBeAttached()
  await helper.focus()
  await expect(helper).toBeFocused()
  await expect(orcaPage.locator('html')).toHaveAttribute('data-regular-terminal-input-focused', '')

  const regions = await orcaPage.evaluate((selectors) => {
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
    }
    const inspect = (selector: string) =>
      Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map((element) => ({
          selector,
          region: getComputedStyle(element).getPropertyValue('-webkit-app-region')
        }))
    return {
      drag: selectors.flatMap(inspect),
      controls: ['.sidebar-toggle', '.window-controls', '.right-sidebar-header-no-drag'].flatMap(
        inspect
      )
    }
  }, dragSurfaces)

  await testInfo.attach('terminal-focused-drag-regions', {
    body: JSON.stringify(regions, null, 2),
    contentType: 'application/json'
  })
  await testInfo.attach('terminal-focused-window', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  expect(regions.drag.some(({ selector }) => selector === '.titlebar-left')).toBe(true)
  expect(regions.drag.some(({ selector }) => selector === '.right-sidebar-header-drag')).toBe(true)
  expect(
    regions.drag.some(({ selector }) => selector === '[data-terminal-focus-release-surface="true"]')
  ).toBe(true)
  for (const { selector, region } of regions.drag) {
    expect
      .soft(region, `${selector} must drag on the first press while the terminal is focused`)
      .toBe('drag')
  }
  expect(regions.controls.length).toBeGreaterThan(0)
  for (const { selector, region } of regions.controls) {
    expect.soft(region, `${selector} must remain interactive`).toBe('no-drag')
  }

  // Interactive chrome still releases terminal input/zoom ownership.
  await orcaPage.locator('.sidebar-toggle').first().click()
  await expect(helper).not.toBeFocused()
  await expect(orcaPage.locator('html')).not.toHaveAttribute('data-regular-terminal-input-focused')
})

import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

for (const closeVia of ['canvas', 'tab-strip']) {
  test(`removes browser cards via ${closeVia} without reviving closed tabs on undo`, async ({
    orcaPage
  }, testInfo) => {
    const errors: string[] = []
    orcaPage.on('pageerror', (error) => errors.push(error.message))
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const ids = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      const browser = state.createBrowserTab(worktreeId, 'about:blank', {
        title: 'Removal test browser'
      })
      const canvas = state.createUnifiedTab(worktreeId, 'canvas', { label: 'Removal test canvas' })
      const scope = JSON.stringify(['workspace-tab', canvas.executionHostId, worktreeId, canvas.id])
      localStorage.setItem(
        `orca.agent-canvas.v1:${scope}`,
        JSON.stringify({
          version: 1,
          viewport: { x: 40, y: 40, zoom: 1 },
          edges: [],
          nodes: [
            {
              id: 'browser',
              kind: 'browser',
              browserTabId: browser.id,
              title: 'Removal test browser',
              content: 'about:blank',
              position: { x: 0, y: 80 },
              width: 720,
              height: 520
            }
          ]
        })
      )
      state.activateTab(canvas.id)
      return { browser: browser.id, canvas: canvas.id }
    }, worktreeId)
    const card = orcaPage.locator('[data-canvas-kind="browser"]')
    const remove = () => card.getByRole('button', { name: 'Remove card', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: 'Remove this card?' })
    const surface = orcaPage.locator('[data-agent-canvas-surface]')
    await expect(card).toBeVisible()
    await remove()
    await expect(
      dialog.getByRole('button', { name: 'Remove from canvas', exact: true })
    ).toBeFocused()
    await expect(dialog.getByRole('button', { name: 'Remove and close tab' })).toBeEnabled()
    await dialog.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(card).toBeVisible()
    await remove()
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    const originalDark = await orcaPage.evaluate(() =>
      document.documentElement.classList.contains('dark')
    )
    for (const dark of [true, false]) {
      await orcaPage.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        dark
      )
      await orcaPage.screenshot({
        path: testInfo.outputPath(`canvas-removal-${dark ? 'dark' : 'light'}.png`),
        animations: 'disabled'
      })
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 700,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false
    })
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await expect(dialog).toBeInViewport()
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await orcaPage.screenshot({
      path: testInfo.outputPath('canvas-removal-narrow.png'),
      animations: 'disabled'
    })
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await orcaPage.evaluate(
      (dark) => document.documentElement.classList.toggle('dark', dark),
      originalDark
    )
    await dialog.getByRole('button', { name: 'Remove from canvas', exact: true }).click()
    await expect(card).toHaveCount(0)
    expect(
      await orcaPage.evaluate(
        ({ browser, worktreeId }) =>
          (window.__store!.getState().browserTabsByWorktree[worktreeId] ?? []).some(
            (tab) => tab.id === browser
          ),
        { browser: ids.browser, worktreeId }
      )
    ).toBe(true)
    await surface.press('ControlOrMeta+z')
    await expect(card).toBeVisible()
    await remove()
    if (closeVia === 'canvas') {
      await dialog.getByRole('button', { name: 'Remove and close tab' }).click()
    } else {
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await orcaPage.locator(`[data-tab-id="${ids.browser}"]`).locator('button').click()
    }
    await expect(card).toHaveCount(0)
    await expect
      .poll(() =>
        orcaPage.evaluate(
          ({ browser, worktreeId }) =>
            (window.__store!.getState().browserTabsByWorktree[worktreeId] ?? []).some(
              (tab) => tab.id === browser
            ),
          { browser: ids.browser, worktreeId }
        )
      )
      .toBe(false)
    await surface.press('ControlOrMeta+z')
    await expect(card).toHaveCount(0)
    await cdp.detach()
    expect(errors).toEqual([])
  })
}

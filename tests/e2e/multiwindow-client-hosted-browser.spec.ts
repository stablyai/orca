import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { startPlacementFixtureServer } from './helpers/paired-browser-placement-fixture'
import {
  browserViewIdForPage,
  openWorkspaceWindow,
  expectHiddenWorkspaceWindows
} from './helpers/workspace-window'
import { worktreeRowSurface } from './worktree-row-locators'

test('secondary window keeps an existing client-hosted browser guest and lease', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  const server = await startPlacementFixtureServer()
  const hostWorktreeId = await orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId!)
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    'Window continuity'
  )
  try {
    await client.page.waitForFunction(
      (worktreeId) =>
        window
          .__store!.getState()
          .allWorktrees()
          .some((worktree) => worktree.id === worktreeId),
      hostWorktreeId
    )
    await client.page.evaluate(
      ({ worktreeId, environmentId }) => {
        const state = window.__store!.getState()
        state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { worktreeId: hostWorktreeId, environmentId: client.environmentId }
    )
    const worktreeId = await client.page.evaluate(async (url) => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId!
      state.setBrowserDefaultUrl(url)
      await state.openNewBrowserTabInActiveWorkspace(state.activeGroupIdByWorktree[worktreeId]!)
      return worktreeId
    }, server.url)
    await expect
      .poll(
        () =>
          client.page.evaluate(() => {
            const state = window.__store!.getState()
            return Object.values(state.remoteBrowserPageHandlesByPageId).find(
              (handle) => handle.placement?.kind === 'client'
            )
          }),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    const original = await client.page.evaluate(() => {
      const state = window.__store!.getState()
      return Object.values(state.remoteBrowserPageHandlesByPageId).find(
        (handle) => handle.placement?.kind === 'client'
      )!
    })
    await expect
      .poll(() =>
        client.app.evaluate(
          ({ webContents }, url) =>
            webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.id ??
            null,
          server.url
        )
      )
      .toBeTruthy()
    const guestId = await client.app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!
      await guest.executeJavaScript(
        `document.body.innerHTML = '<input id="continuity" value="original" style="position:fixed;left:0;top:0;width:400px;height:80px">'`
      )
      return guest.id
    }, server.url)
    const secondary = await openWorkspaceWindow(client.app)
    const errors: string[] = []
    secondary.on('pageerror', (error) => errors.push(error.message))
    const catalog = await secondary.evaluate(() => window.api.runtimeEnvironments.list())
    expect(catalog.some((environment) => environment.id === client.environmentId)).toBe(true)
    expect(catalog.length).toBeGreaterThan(1)
    await worktreeRowSurface(secondary, worktreeId).click()
    const viewId = await browserViewIdForPage(secondary, original.remotePageId)
    await secondary.locator(`[data-tab-id="${viewId}"]`).click()
    await expect(secondary.getByAltText('Shared browser view')).toBeVisible()
    await secondary.getByRole('button', { name: 'Take Control Here' }).click()
    await expectHiddenWorkspaceWindows(client.app)
    const frame = secondary.getByTestId('remote-browser-frame')
    await expect(frame).toBeVisible({ timeout: 30_000 })
    await frame.click({ position: { x: 50, y: 30 } })
    await frame.press('End')
    await frame.pressSequentially('-secondary')
    await expect
      .poll(() =>
        client.app.evaluate(
          async ({ webContents }, id) =>
            webContents
              .fromId(id)!
              .executeJavaScript('document.querySelector("#continuity").value'),
          guestId
        )
      )
      .toBe('original-secondary')
    const primaryId = await client.page.evaluate(() => window.orcaWorkspaceViews!.ready())
    await client.page.evaluate(() => window.api.ui.requestClose())
    await expect
      .poll(() =>
        secondary.evaluate(
          async (id) => (await window.orcaWorkspaceViews!.list()).some((entry) => entry.id === id),
          primaryId
        )
      )
      .toBe(false)
    await secondary.reload()
    await secondary.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await worktreeRowSurface(secondary, worktreeId).click()
    const restoredViewId = await browserViewIdForPage(secondary, original.remotePageId)
    await secondary.locator(`[data-tab-id="${restoredViewId}"]`).click()
    await expect(secondary.getByTestId('remote-browser-frame')).toBeVisible({ timeout: 30_000 })
    const current = await client.page.evaluate(
      (pageId) =>
        Object.values(window.__store!.getState().remoteBrowserPageHandlesByPageId).find(
          (handle) => handle.remotePageId === pageId
        ),
      original.remotePageId
    )
    expect(current?.placement).toEqual(original.placement)
    expect(
      await client.app.evaluate(
        async ({ webContents }, id) =>
          webContents.fromId(id)!.executeJavaScript('document.querySelector("#continuity").value'),
        guestId
      )
    ).toBe('original-secondary')
    await secondary.screenshot({
      path: testInfo.outputPath('client-hosted-browser-continuity.png')
    })
    expect(errors).toEqual([])
    await expectHiddenWorkspaceWindows(client.app)
  } finally {
    await client.dispose()
    await server.close()
  }
})

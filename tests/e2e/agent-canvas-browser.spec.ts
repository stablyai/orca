import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('uses a live Orca browser inside the canvas without recreating its guest', async ({
  orcaPage
}, testInfo) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Canvas preview</title>
      <body><h1>${request.url === '/second' ? 'Second page' : 'Live canvas browser'}</h1>
      <input aria-label="Draft" placeholder="Keep this draft"><a href="/second">Next page</a></body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await orcaPage.getByRole('button', { name: 'New tab', exact: true }).click()
    await orcaPage.getByRole('menuitem', { name: 'New Canvas', exact: true }).click()
    await orcaPage.getByRole('button', { name: 'Browser', exact: true }).click()
    await orcaPage.getByRole('textbox', { name: 'Browser URL', exact: true }).fill(url)
    await orcaPage.getByRole('button', { name: 'Open page', exact: true }).click()
    const card = orcaPage.locator('[data-canvas-kind="browser"]')
    const viewport = card.locator('[data-canvas-browser]')
    await expect(viewport).not.toHaveAttribute('data-canvas-browser', '')
    const id = await viewport.getAttribute('data-canvas-browser')
    const pane = orcaPage.locator(`[data-browser-overlay-tab-id="${id}"]`)
    const guest = pane.locator('webview')
    await expect(guest).toBeVisible({ timeout: 30_000 })
    const heading = () =>
      guest.evaluate((element) =>
        (element as Electron.WebviewTag).executeJavaScript(
          'document.querySelector("h1")?.textContent'
        )
      )
    await expect.poll(heading).toBe('Live canvas browser')
    await expect(orcaPage.locator('[data-workspace-canvas]')).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await expect
      .poll(async () => {
        const actual = await pane.boundingBox()
        const target = await viewport.boundingBox()
        return Math.max(
          Math.abs(actual!.x - target!.x),
          Math.abs(actual!.y - target!.y),
          Math.abs(actual!.width - target!.width),
          Math.abs(actual!.height - target!.height)
        )
      })
      .toBeLessThan(2)
    const originalGuest = await guest.elementHandle()
    const guestId = await guest.evaluate((element) =>
      (element as Electron.WebviewTag).getWebContentsId()
    )
    await guest.evaluate((element) =>
      (element as Electron.WebviewTag).executeJavaScript(
        'document.querySelector("input").value = "draft preserved"'
      )
    )
    const header = card.locator('.canvas-node-header')
    const before = await header.boundingBox()
    await orcaPage.mouse.move(before!.x + 45, before!.y + 10)
    await orcaPage.mouse.down()
    for (let step = 1; step <= 10; step++) {
      await orcaPage.mouse.move(before!.x + 45 + step * 8, before!.y + 10 + step * 3)
      expect(await originalGuest!.evaluate((element) => element.isConnected)).toBe(true)
      await expect(guest).toBeVisible()
    }
    await orcaPage.mouse.up()
    expect((await header.boundingBox())!.x - before!.x).toBeGreaterThan(40)
    await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    expect(
      await guest.evaluate((element) => (element as Electron.WebviewTag).getWebContentsId())
    ).toBe(guestId)
    expect(
      await guest.evaluate((element) =>
        (element as Electron.WebviewTag).executeJavaScript('document.querySelector("input").value')
      )
    ).toBe('draft preserved')
    await orcaPage.screenshot({ path: testInfo.outputPath('canvas-live-browser.png') })
    const linkPoint = await guest.evaluate((element) =>
      (element as Electron.WebviewTag).executeJavaScript(
        '(() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()'
      )
    )
    const guestBox = await guest.boundingBox()
    await orcaPage.mouse.click(guestBox!.x + linkPoint.x, guestBox!.y + linkPoint.y)
    await expect.poll(heading).toBe('Second page')
    await pane.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(heading).toBe('Live canvas browser')
    await pane.getByRole('button', { name: 'Reload', exact: true }).click()
    await expect.poll(heading).toBe('Live canvas browser')
    await orcaPage.getByRole('button', { name: 'Note', exact: true }).click()
    await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const note = orcaPage.locator('[data-canvas-kind="note"]')
    const noteHeader = await note.locator('.canvas-node-header').boundingBox()
    const browserBounds = await card.boundingBox()
    await orcaPage.mouse.move(noteHeader!.x + 35, noteHeader!.y + noteHeader!.height / 2)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(browserBounds!.x + 85, browserBounds!.y + 120, { steps: 12 })
    await orcaPage.mouse.up()
    const noteInput = note.getByRole('textbox', { name: 'Note content' })
    await expect
      .poll(async () => {
        const a = (await note.boundingBox())!
        const b = (await card.boundingBox())!
        return (
          Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
        )
      })
      .toBeGreaterThan(1000)
    await noteInput.click()
    await noteInput.fill('A note above the live browser')
    await expect(noteInput).toHaveValue('A note above the live browser')
    await expect(guest).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('canvas-browser-overlap-desktop.png') })
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    })
    await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await guest.evaluate((element) =>
      (element as Electron.WebviewTag).executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
      )
    )
    await orcaPage.screenshot({ path: testInfo.outputPath('canvas-browser-note-overlap.png') })
    await cdp.detach()
    await note.getByRole('button', { name: 'Remove card', exact: true }).click()
    await card.getByRole('button', { name: 'Remove card', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(pane).not.toBeVisible()
    await orcaPage.getByRole('button', { name: 'Undo canvas edit', exact: true }).click()
    await expect(guest).toBeVisible()
    expect(
      await guest.evaluate((element) => (element as Electron.WebviewTag).getWebContentsId())
    ).toBe(guestId)
    await orcaPage
      .locator('[data-tab-group-strip-id]')
      .getByText('Canvas preview', { exact: true })
      .click()
    await expect(orcaPage.locator('[data-workspace-canvas]')).toHaveCount(0)
    await expect(guest).toBeVisible()
    await orcaPage.locator('[data-tab-group-strip-id]').getByText('Canvas', { exact: true }).click()
    await expect(card).toBeVisible()
    expect(
      await guest.evaluate((element) => (element as Electron.WebviewTag).getWebContentsId())
    ).toBe(guestId)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

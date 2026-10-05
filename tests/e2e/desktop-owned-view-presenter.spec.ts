import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { ElectronApplication, Locator, Page, TestInfo } from '@stablyai/playwright-test'
import type { DesktopBrowserViewIdentity } from '../../src/shared/desktop-browser-view-protocol'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree } from './helpers/store'
import { assertOwnedViewFullPageCapture } from './helpers/owned-view-full-page-capture'

async function startGuest(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Owned view guest</title>
      <style>body{margin:0;background:#9edbd0}button{position:absolute;left:32px;top:120px;width:180px;height:48px}</style>
      <div style="height:1024px;background:rgb(255,0,0)"></div>
      <div style="height:1024px;background:rgb(0,255,0)"></div>
      <div style="height:1024px;background:rgb(0,0,255)"></div>
      <div style="height:1024px;background:rgb(255,255,0)"></div>
      <button id="guest">Guest clicks: 0</button>
      <script>let clicks=0;document.getElementById('guest').onclick=()=>{
        document.getElementById('guest').textContent='Guest clicks: '+(++clicks);
        document.title='Guest clicks: '+clicks;
      }</script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Guest server address missing')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function readNative(app: ElectronApplication, url: string) {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }, targetUrl) => {
    const owner = BrowserWindow.getAllWindows()[0]
    if (!owner) {
      throw new Error('Fixture owner window missing')
    }
    function find(
      view: Electron.View,
      parent: Electron.View | null
    ): {
      guest: Electron.WebContentsView
      parent: Electron.View
    } | null {
      if (view instanceof WebContentsView && view.webContents.getURL() === targetUrl && parent) {
        return { guest: view, parent }
      }
      for (const child of view.children) {
        const found = find(child, view)
        if (found) {
          return found
        }
      }
      return null
    }
    const found = find(owner.contentView, null)
    if (!found) {
      return null
    }
    const guestText: unknown = await found.guest.webContents.executeJavaScript(
      "document.getElementById('guest')?.textContent"
    )
    return {
      guestId: found.guest.webContents.id,
      container: found.parent.getBounds(),
      content: found.guest.getBounds(),
      containerVisible: found.parent.getVisible(),
      guestVisible: found.guest.getVisible(),
      visible: found.parent.getVisible() && found.guest.getVisible(),
      ownerVisible: owner.isVisible(),
      ownerWindows: BrowserWindow.getAllWindows()
        .slice(0, 8)
        .map((window) => ({
          id: window.id,
          visible: window.isVisible(),
          bounds: window.getContentBounds(),
          rendererId: window.webContents.id,
          url: window.webContents.getURL()
        })),
      owner: owner.getContentBounds(),
      scale: owner.webContents.getZoomFactor(),
      guestText: typeof guestText === 'string' ? guestText : null
    }
  }, url)
}

async function assertLayout(
  page: Page,
  app: ElectronApplication,
  url: string,
  pageId: string,
  testInfo: TestInfo,
  stage: string
) {
  let lastSample: Record<string, unknown> = { stage, pageId, samples: 0 }
  let samples = 0
  try {
    await expect
      .poll(async () => {
        const rectangles = await page
          .locator(`[data-browser-page-viewport-id="${pageId}"]`)
          .evaluate((shell) => {
            const content = shell.querySelector('[data-browser-page-content]')
            const scroller = shell.querySelector('[data-browser-page-scroller]')
            if (!content || !scroller) {
              throw new Error('Ordinary viewport elements missing')
            }
            const bounds = (element: Element) => {
              const rect = element.getBoundingClientRect()
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            }
            const presenter = content.querySelector('textarea')
            const style = getComputedStyle(shell)
            const overlays = Array.from(
              document.querySelectorAll(
                '[data-slot="dialog-overlay"], [data-slot="sheet-overlay"], [data-slot="popover-content"], [data-slot="tooltip-content"], [data-slot="dropdown-menu-content"], [role="dialog"]'
              )
            )
              .filter((element) => {
                const rect = element.getBoundingClientRect()
                const style = getComputedStyle(element)
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden'
                )
              })
              .slice(0, 16)
              .map((element) => ({
                slot: element.getAttribute('data-slot'),
                role: element.getAttribute('role'),
                state: element.getAttribute('data-state'),
                bounds: bounds(element)
              }))
            return {
              content: bounds(content),
              clip: bounds(scroller),
              shell: {
                connected: shell.isConnected,
                ariaHidden: shell.getAttribute('aria-hidden'),
                display: style.display,
                visibility: style.visibility
              },
              presenter: {
                disabled: presenter?.disabled,
                bounds: presenter ? bounds(presenter) : null
              },
              renderer: {
                hidden: document.hidden,
                visibilityState: document.visibilityState,
                activeModal: window.__store?.getState().activeModal ?? null
              },
              occlusion: {
                nativeSnapshot: 'Unavailable through ordinary preload API; DOM candidates only',
                overlays
              }
            }
          })
        samples++
        lastSample = {
          stage,
          pageId,
          samples,
          sampledAt: new Date().toISOString(),
          raw: rectangles
        }
        const readback = await readNative(app, url)
        lastSample.native = readback
        if (!readback) {
          lastSample.failedPredicates = ['nativeGuestFound']
          return false
        }
        const scaled = (rect: typeof rectangles.content) => ({
          x: Math.round(Math.round(rect.x) * readback.scale),
          y: Math.round(Math.round(rect.y) * readback.scale),
          width: Math.max(1, Math.round(Math.round(rect.width) * readback.scale)),
          height: Math.max(1, Math.round(Math.round(rect.height) * readback.scale))
        })
        const content = scaled(rectangles.content)
        const clip = scaled(rectangles.clip)
        const left = Math.max(0, content.x, clip.x)
        const top = Math.max(0, content.y, clip.y)
        const right = Math.min(readback.owner.width, content.x + content.width, clip.x + clip.width)
        const bottom = Math.min(
          readback.owner.height,
          content.y + content.height,
          clip.y + clip.height
        )
        const predicates = {
          nativeVisible: readback.visible,
          ownerHidden: !readback.ownerVisible,
          containerX: readback.container.x === left,
          containerY: readback.container.y === top,
          containerWidth: readback.container.width === right - left,
          containerHeight: readback.container.height === bottom - top,
          contentX: readback.content.x === content.x - left,
          contentY: readback.content.y === content.y - top,
          contentWidth: readback.content.width === content.width,
          contentHeight: readback.content.height === content.height
        }
        lastSample.expected = {
          scaledContent: content,
          scaledClip: clip,
          container: { x: left, y: top, width: right - left, height: bottom - top },
          content: {
            x: content.x - left,
            y: content.y - top,
            width: content.width,
            height: content.height
          }
        }
        lastSample.predicates = predicates
        lastSample.failedPredicates = Object.entries(predicates)
          .filter(([, passed]) => !passed)
          .map(([name]) => name)
        return Object.values(predicates).every(Boolean)
      })
      .toBe(true)
  } catch (error) {
    lastSample.hostWindowsAtFailure = await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .slice(0, 8)
          .map((window) => ({
            id: window.id,
            visible: window.isVisible(),
            bounds: window.getContentBounds(),
            rendererId: window.webContents.id,
            zoom: window.webContents.getZoomFactor()
          }))
      )
      .catch((hostError: unknown) => ({ unavailable: String(hostError) }))
    const retained = await Promise.allSettled([
      testInfo.attach(`${stage}-layout-failure.json`, {
        body: JSON.stringify({ ...lastSample, assertionError: String(error) }, null, 2),
        contentType: 'application/json'
      }),
      page
        .screenshot({
          path: testInfo.outputPath(`${stage}-layout-before-cleanup.png`),
          timeout: 5_000
        })
        .then((body) =>
          testInfo.attach(`${stage}-layout-before-cleanup.png`, { body, contentType: 'image/png' })
        )
    ])
    for (const result of retained) {
      if (result.status === 'rejected') {
        console.warn(
          '[owned-view-e2e] retaining layout failure evidence failed:',
          String(result.reason)
        )
      }
    }
    throw error
  }
  const readback = await readNative(app, url)
  if (!readback) {
    throw new Error('Native layout readback missing')
  }
  return readback
}

async function captureEvidence(
  page: Page,
  identity: DesktopBrowserViewIdentity,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const capture = await page.evaluate(async (target) => {
    const api = window.api.browser.desktopView
    if (!api) {
      throw new Error('Ordinary desktop preload API missing')
    }
    return api.captureViewport(target)
  }, identity)
  expect(capture.width).toBeGreaterThan(0)
  expect(capture.height).toBeGreaterThan(0)
  expect(capture.dataUrl).toMatch(/^data:image\/png;base64,/)
  await testInfo.attach(`${name}-native-guest.png`, {
    body: Buffer.from(capture.dataUrl.split(',')[1], 'base64'),
    contentType: 'image/png'
  })
  // Renderer CDP and guest viewport images do not establish composed native-child pixels.
  await page.screenshot({ path: testInfo.outputPath(`${name}-renderer.png`) })
}

async function guestPoint(textarea: Locator) {
  return textarea.evaluate((element) => {
    const content = element.closest('[data-browser-page-content]')
    if (!content) {
      throw new Error('Presenter content rectangle missing')
    }
    const rect = content.getBoundingClientRect()
    return { x: rect.left + 122, y: rect.top + 144 }
  })
}

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('ordinary owned-view presenter forwards, clips, occludes, captures, and destroys', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.skip(testInfo.project.metadata.orcaHeadful === true, 'Requires the isolated hidden fixture')
  const guest = await startGuest()
  const pageId = `owned-view-e2e-${randomUUID()}`
  let created: { browserTabId: string; browserPageId: string; generation: string } | null = null
  let primaryFailed = false
  let primaryError: unknown
  try {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    created = await orcaPage.evaluate(
      async ({ worktreeId, url, pageId }) => {
        const store = window.__store
        const api = window.api.browser.desktopView
        if (!store || !api) {
          throw new Error('Ordinary store or desktop API missing')
        }
        await store.getState().updateSettings({ uiLanguage: 'en' })
        let unsubscribe = () => {}
        const generation = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            unsubscribe()
            reject(new Error('Ordinary owned-view state event missing'))
          }, 15_000)
          unsubscribe = api.onEvent((event) => {
            if (
              event.kind === 'state' &&
              event.state.browserPageId === pageId &&
              !event.state.loading &&
              event.state.url === url
            ) {
              clearTimeout(timer)
              unsubscribe()
              resolve(event.state.generation)
            }
          })
        })
        const tab = store.getState().createBrowserTab(worktreeId, url, {
          activate: true,
          browserPageId: pageId,
          title: 'Owned view E2E'
        })
        return { browserTabId: tab.id, browserPageId: pageId, generation: await generation }
      },
      { worktreeId, url: guest.url, pageId }
    )
    const identity = { browserPageId: created.browserPageId, generation: created.generation }
    const textarea = orcaPage.getByRole('textbox', { name: 'Browser page', exact: true })
    await expect(textarea).toBeVisible()
    await expect(textarea).toBeEnabled()
    // Fresh isolated profiles show a separate first-use markup hint over the native viewport.
    const drawHint = orcaPage.locator('[data-slot="popover-content"]').filter({
      hasText: 'Draw on the page, then copy the markup to paste into your agent.'
    })
    await expect(drawHint).toBeVisible()
    await drawHint.getByRole('button', { name: 'Got it', exact: true }).click()
    await expect(drawHint).toBeHidden()
    const initial = await assertLayout(
      orcaPage,
      electronApp,
      guest.url,
      pageId,
      testInfo,
      'initial'
    )
    expect(initial.guestText).toBe('Guest clicks: 0')
    await captureEvidence(orcaPage, identity, testInfo, 'initial')
    await assertOwnedViewFullPageCapture({
      page: orcaPage,
      identity,
      worktreeId,
      url: guest.url,
      expectedGuestId: initial.guestId,
      readNative: () => readNative(electronApp, guest.url),
      testInfo
    })
    await assertLayout(orcaPage, electronApp, guest.url, pageId, testInfo, 'full-page-restored')

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(900, 640)
    })
    const resized = await assertLayout(
      orcaPage,
      electronApp,
      guest.url,
      pageId,
      testInfo,
      'resized'
    )
    expect(resized.owner.width).toBe(900)
    expect(resized.owner.height).toBe(640)
    expect(resized.guestId).toBe(initial.guestId)
    await orcaPage.evaluate(
      (id) => window.__store?.getState().setBrowserPageViewportPreset(id, 'desktop'),
      pageId
    )
    const scroller = orcaPage.locator(
      `[data-browser-page-viewport-id="${pageId}"] [data-browser-page-scroller]`
    )
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true)
    await scroller.evaluate((element) => {
      element.scrollLeft = 120
      element.scrollTop = 80
    })
    const clipped = await assertLayout(
      orcaPage,
      electronApp,
      guest.url,
      pageId,
      testInfo,
      'clipped'
    )
    expect(clipped.content.width).toBeGreaterThan(clipped.container.width)
    expect(clipped.content.height).toBeGreaterThan(clipped.container.height)
    expect(clipped.content.y).toBeLessThan(0)
    await testInfo.attach('clipped-live-layout.json', {
      body: JSON.stringify(clipped, null, 2),
      contentType: 'application/json'
    })
    await captureEvidence(orcaPage, identity, testInfo, 'clipped')
    await orcaPage.evaluate(
      (id) => window.__store?.getState().setBrowserPageViewportPreset(id, null),
      pageId
    )
    await assertLayout(orcaPage, electronApp, guest.url, pageId, testInfo, 'restored')

    // The existing find bar selects captured-frame forwarding outside its rectangle.
    await orcaPage.keyboard.press('ControlOrMeta+f')
    const find = orcaPage.getByPlaceholder('Find in page...', { exact: true })
    await expect(find).toBeVisible()
    await expect.poll(async () => (await readNative(electronApp, guest.url))?.visible).toBe(false)
    const point = await guestPoint(textarea)
    const findCoversPoint = await find.evaluate((element, point) => {
      const rect = element.parentElement!.getBoundingClientRect()
      return (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      )
    }, point)
    expect(findCoversPoint).toBe(false)
    expect(
      await textarea.evaluate(
        (element, point) => document.elementFromPoint(point.x, point.y) === element,
        point
      )
    ).toBe(true)
    await orcaPage.mouse.click(point.x, point.y)
    await expect
      .poll(async () => (await readNative(electronApp, guest.url))?.guestText)
      .toBe('Guest clicks: 1')
    await captureEvidence(orcaPage, identity, testInfo, 'forwarded')

    await orcaPage.evaluate(() => window.__store?.getState().openModal('add-repo'))
    const dialog = orcaPage.getByRole('dialog', { name: 'Add a project', exact: true })
    await expect(dialog).toBeVisible()
    const overlay = orcaPage.locator('[data-slot="dialog-overlay"][data-state="open"]')
    await expect(overlay).toBeVisible()
    expect(
      await overlay.evaluate((element, point) => {
        const rect = element.getBoundingClientRect()
        return (
          point.x >= rect.left &&
          point.x <= rect.right &&
          point.y >= rect.top &&
          point.y <= rect.bottom
        )
      }, point)
    ).toBe(true)
    // Dispatch to the covered presenter itself to exercise its occlusion refusal.
    const coveredPresenter = orcaPage
      .locator(`[data-browser-page-viewport-id="${pageId}"]`)
      .getByRole('textbox', { name: 'Browser page', exact: true, includeHidden: true })
    await expect(coveredPresenter).toBeAttached()
    await coveredPresenter.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: 1
    })
    await coveredPresenter.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: 0
    })
    await orcaPage.evaluate(async (identity) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      await window.api.browser.desktopView?.command({ ...identity, command: { kind: 'snapshot' } })
    }, identity)
    expect((await readNative(electronApp, guest.url))?.guestText).toBe('Guest clicks: 1')
    await captureEvidence(orcaPage, identity, testInfo, 'modal-blocked')
    expect((await readNative(electronApp, guest.url))?.guestText).toBe('Guest clicks: 1')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(overlay).toBeHidden()
    await expect(find).toBeVisible()
    await orcaPage.mouse.click(point.x, point.y)
    await expect
      .poll(async () => (await readNative(electronApp, guest.url))?.guestText)
      .toBe('Guest clicks: 2')
    await captureEvidence(orcaPage, identity, testInfo, 'modal-dismissed')

    await find.locator('..').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(find).toBeHidden()
    const direct = await assertLayout(
      orcaPage,
      electronApp,
      guest.url,
      pageId,
      testInfo,
      'find-closed'
    )
    expect(direct.guestId).toBe(initial.guestId)
    expect(direct.guestText).toBe('Guest clicks: 2')
    await captureEvidence(orcaPage, identity, testInfo, 'direct-native')

    await orcaPage.evaluate(() => window.__store?.getState().openModal('add-repo'))
    await expect(dialog).toBeVisible()
    await expect(overlay).toBeVisible()
    await expect.poll(async () => (await readNative(electronApp, guest.url))?.visible).toBe(false)
    await expect(coveredPresenter).toBeAttached()
    await coveredPresenter.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: 1
    })
    await coveredPresenter.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: 0
    })
    await orcaPage.evaluate(async (identity) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      await window.api.browser.desktopView?.command({ ...identity, command: { kind: 'snapshot' } })
    }, identity)
    const directBlocked = await readNative(electronApp, guest.url)
    expect(directBlocked?.visible).toBe(false)
    expect(directBlocked?.guestId).toBe(initial.guestId)
    expect(directBlocked?.guestText).toBe('Guest clicks: 2')
    await testInfo.attach('direct-native-modal-hidden.json', {
      body: JSON.stringify(directBlocked, null, 2),
      contentType: 'application/json'
    })
    await captureEvidence(orcaPage, identity, testInfo, 'direct-native-modal-blocked')
    expect((await readNative(electronApp, guest.url))?.guestText).toBe('Guest clicks: 2')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(overlay).toBeHidden()
    await expect(find).toBeHidden()
    const directRestored = await assertLayout(
      orcaPage,
      electronApp,
      guest.url,
      pageId,
      testInfo,
      'direct-modal-dismissed'
    )
    expect(directRestored.guestId).toBe(initial.guestId)
    expect(directRestored.guestText).toBe('Guest clicks: 2')
    await testInfo.attach('direct-native-modal-transition.json', {
      body: JSON.stringify(
        { before: direct, modal: directBlocked, after: directRestored },
        null,
        2
      ),
      contentType: 'application/json'
    })
    await captureEvidence(orcaPage, identity, testInfo, 'direct-native-modal-dismissed')
  } catch (error) {
    primaryFailed = true
    primaryError = error
  }
  try {
    try {
      if (created) {
        await orcaPage.evaluate(
          (id) => window.__store?.getState().closeBrowserTab(id),
          created.browserTabId
        )
        await expect(
          orcaPage.getByRole('textbox', { name: 'Browser page', exact: true })
        ).toBeHidden()
        await expect.poll(() => readNative(electronApp, guest.url)).toBeNull()
        await expect
          .poll(() =>
            electronApp.evaluate(
              ({ webContents }, url) =>
                webContents.getAllWebContents().some((guest) => guest.getURL() === url),
              guest.url
            )
          )
          .toBe(false)
      }
    } finally {
      await guest.close()
    }
  } catch (error) {
    if (!primaryFailed) {
      throw error
    }
    await testInfo
      .attach('cleanup-after-primary-failure.json', {
        body: JSON.stringify({ cleanupError: String(error) }),
        contentType: 'application/json'
      })
      .catch((attachmentError: unknown) =>
        console.warn('[owned-view-e2e] retaining cleanup error failed:', String(attachmentError))
      )
  }
  if (primaryFailed) {
    throw primaryError
  }
})

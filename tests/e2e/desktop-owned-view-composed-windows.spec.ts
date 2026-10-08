import { randomUUID } from 'node:crypto'
import { startGuest, readFallback } from './helpers/owned-view-composed-guest'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree } from './helpers/store'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import {
  ComposedRendezvous,
  retainFallback,
  type FallbackDiagnostics,
  type NativeDomProof,
  type NativeDiscriminator,
  type ComposedStage,
  type PixelSample,
  type ScreenRect
} from './helpers/owned-view-composed-rendezvous'
const controlDirectory = process.env.ORCA_COMPOSED_CONTROL_DIR
const controlToken = process.env.ORCA_COMPOSED_TOKEN
const rendezvous =
  controlDirectory && controlToken ? new ComposedRendezvous(controlDirectory, controlToken) : null
test.skip(
  process.platform !== 'win32' || !controlDirectory || !controlToken,
  'Requires the explicit Windows composed-capture supervisor'
)
test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

async function readNative(app: ElectronApplication, ownerId: number, url: string) {
  return retryTransientMainEvaluate(() =>
    app.evaluate(
      ({ BrowserWindow, WebContentsView, screen, app }, args) => {
        const owner = BrowserWindow.fromId(args.ownerId)
        if (!owner || owner.isDestroyed()) {
          throw new Error('Exact fixture owner missing')
        }
        function find(
          view: Electron.View,
          parent: Electron.View | null
        ): {
          guest: Electron.WebContentsView
          parent: Electron.View
        } | null {
          if (view instanceof WebContentsView && parent && view.webContents.getURL() === args.url) {
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
        const container = found.parent.getBounds()
        const content = found.guest.getBounds()
        const contentBounds = owner.getContentBounds()
        const left = Math.max(0, content.x)
        const top = Math.max(0, content.y)
        const right = Math.min(container.width, content.x + content.width)
        const bottom = Math.min(container.height, content.y + content.height)
        const clipStart = screen.dipToScreenPoint({
          x: contentBounds.x + container.x + left,
          y: contentBounds.y + container.y + top
        })
        const clipEnd = screen.dipToScreenPoint({
          x: contentBounds.x + container.x + right,
          y: contentBounds.y + container.y + bottom
        })
        const handle = owner.getNativeWindowHandle()
        const hwnd = Number(handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE())
        if (!Number.isSafeInteger(hwnd) || hwnd <= 0) {
          throw new Error('Invalid fixture HWND')
        }
        return {
          pid: process.pid,
          hwnd,
          executable: process.execPath,
          electronVersion: process.versions.electron,
          home: app.getPath('home'),
          userData: app.getPath('userData'),
          owner: {
            id: owner.id,
            rendererId: owner.webContents.id,
            visible: owner.isVisible(),
            bounds: owner.getBounds(),
            contentBounds,
            zoom: owner.webContents.getZoomFactor()
          },
          nativeGuest: {
            guestId: found.guest.webContents.id,
            container,
            content,
            loading: found.guest.webContents.isLoadingMainFrame(),
            title: found.guest.webContents.getTitle(),
            visible: found.parent.getVisible() && found.guest.getVisible(),
            containerVisible: found.parent.getVisible(),
            guestVisible: found.guest.getVisible(),
            zoom: found.guest.webContents.getZoomFactor(),
            screenRect: {
              x: clipStart.x,
              y: clipStart.y,
              width: clipEnd.x - clipStart.x,
              height: clipEnd.y - clipStart.y
            }
          }
        }
      },
      { ownerId, url }
    )
  )
}

async function nativeProof(
  app: ElectronApplication,
  ownerId: number,
  guestId: number,
  url: string,
  token: string,
  rgb: number[],
  mutate: boolean
): Promise<NativeDomProof> {
  return app.evaluate(
    async ({ BrowserWindow, WebContentsView }, args) => {
      const owner = BrowserWindow.fromId(args.ownerId)
      if (!owner || owner.isDestroyed() || !owner.isVisible()) {
        throw new Error('Native proof owner unavailable')
      }
      function find(
        view: Electron.View,
        parent: Electron.View | null
      ): Electron.WebContentsView | null {
        if (
          view instanceof WebContentsView &&
          view.webContents.id === args.guestId &&
          view.webContents.getURL() === args.url &&
          parent?.getVisible() &&
          view.getVisible()
        ) {
          return view
        }
        for (const child of view.children) {
          const guest = find(child, view)
          if (guest) {
            return guest
          }
        }
        return null
      }
      const guest = find(owner.contentView, null)
      if (!guest) {
        throw new Error('Exact visible owned native guest missing')
      }
      const result: unknown = await guest.webContents.executeJavaScript(`(() => {
      const patch = document.getElementById('native-proof-patch')
      if (!patch) throw new Error('Native proof patch missing')
      const request = ${JSON.stringify({ token: args.token, rgb: args.rgb, mutate: args.mutate })}
      if (request.mutate) {
        patch.style.backgroundColor = 'rgb(' + request.rgb.join(',') + ')'
        patch.dataset.proofToken = request.token
      }
      const match = getComputedStyle(patch).backgroundColor.match(/^rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)$/)
      return { token: patch.dataset.proofToken, rgb: match ? match.slice(1).map(Number) : null }
    })()`)
      if (
        !result ||
        typeof result !== 'object' ||
        !('token' in result) ||
        result.token !== args.token ||
        !('rgb' in result) ||
        !Array.isArray(result.rgb) ||
        result.rgb.length !== 3 ||
        result.rgb.some((channel, index) => channel !== args.rgb[index])
      ) {
        throw new Error('Native DOM proof mismatch')
      }
      return { guestId: guest.webContents.id, token: result.token, rgb: result.rgb }
    },
    { ownerId, guestId, url, token, rgb, mutate }
  )
}

async function installMarker(page: Page, modal: boolean, pageId: string) {
  return page.evaluate(
    ({ modal, pageId }) => {
      const scroller = document.querySelector(
        `[data-browser-page-viewport-id="${pageId}"] [data-browser-page-scroller]`
      )
      if (!scroller) {
        throw new Error('Native guest clip DOM missing')
      }
      const clip = scroller.getBoundingClientRect()
      const marker = document.createElement('div')
      marker.id = modal ? 'composed-modal-marker' : 'composed-renderer-marker'
      marker.setAttribute('aria-hidden', 'true')
      marker.style.cssText =
        'position:fixed;width:16px;height:16px;pointer-events:none;z-index:2147483647;'
      let parent: Element = document.body
      if (modal) {
        const dialog = document.querySelector('[role="dialog"][data-state="open"]')
        if (!(dialog instanceof HTMLElement)) {
          throw new Error('Actual open dialog missing')
        }
        const rect = dialog.getBoundingClientRect()
        const left = Math.max(rect.left, clip.left) + 16
        const right = Math.min(rect.right, clip.right) - 16
        const top = Math.max(rect.top, clip.top) + 16
        const bottom = Math.min(rect.bottom, clip.bottom) - 16
        if (right <= left || bottom <= top) {
          throw new Error('Dialog does not cover former native guest')
        }
        marker.style.position = 'absolute'
        marker.style.left = `${(left + right) / 2 - rect.left - 8}px`
        marker.style.top = `${(top + bottom) / 2 - rect.top - 8}px`
        marker.style.background = 'rgb(0,255,255)'
        parent = dialog
      } else {
        marker.style.left = '12px'
        marker.style.top = '50px'
        marker.style.background = 'rgb(255,0,255)'
      }
      parent.appendChild(marker)
      const rect = marker.getBoundingClientRect()
      const x = rect.x + rect.width / 2
      const y = rect.y + rect.height / 2
      const inside = x > clip.left && x < clip.right && y > clip.top && y < clip.bottom
      if (inside !== modal) {
        throw new Error('Diagnostic marker is on the wrong side of the guest clip')
      }
      return {
        id: marker.id,
        role: modal ? 'modal' : 'renderer',
        description: 'Runtime-only noninteractive 16px diagnostic paint; no occlusion registration',
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        rgb: modal ? [0, 255, 255] : [255, 0, 255]
      }
    },
    { modal, pageId }
  )
}

test('owned native browser visible-composed modal restoration Windows @headful', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(130_000)
  expect(testInfo.project.metadata.orcaHeadful).toBe(true)
  if (!rendezvous) {
    throw new Error('Supervisor opt-in missing')
  }
  const ownerId = await electronApp.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length !== 1 || windows[0].isVisible()) {
      throw new Error('Expected one initially hidden owned window')
    }
    const owner = windows[0]
    const work = screen.getPrimaryDisplay().workArea
    const width = Math.min(1100, work.width)
    const height = Math.min(640, work.height)
    owner.setBounds({
      x: work.x + Math.floor((work.width - width) / 2),
      y: work.y + Math.floor((work.height - height) / 2),
      width,
      height
    })
    return owner.id
  })
  const guest = await startGuest()
  const pageId = `owned-composed-${randomUUID()}`
  let browserTabId: string | undefined
  let failed = false
  let primaryError: unknown
  const cleanupErrors: string[] = []
  const fallbackDiagnostics: FallbackDiagnostics = { attempts: 0, entries: [] }
  try {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    browserTabId = await orcaPage.evaluate(
      async ({ worktreeId, url, pageId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Fixture store missing')
        }
        await window.api.ui.set({ statusBarItems: [] })
        await store.getState().updateSettings({ uiLanguage: 'en' })
        return store.getState().createBrowserTab(worktreeId, url, {
          activate: true,
          browserPageId: pageId,
          title: 'Composed synthetic guest'
        }).id
      },
      { worktreeId, url: guest.url, pageId }
    )
    const presenter = orcaPage.getByRole('textbox', { name: 'Browser page', exact: true })
    await expect(presenter).toBeVisible()
    await expect(presenter).toBeEnabled()
    const drawHint = orcaPage.locator('[data-slot="popover-content"]').filter({
      hasText: 'Draw on the page, then copy the markup to paste into your agent.'
    })
    await expect(drawHint).toBeVisible()
    await expect
      .poll(
        async () => {
          const sample = await readNative(electronApp, ownerId, guest.url)
          return (
            sample &&
            !sample.nativeGuest.loading &&
            sample.nativeGuest.title === 'Composed synthetic guest'
          )
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    const hidden = await readNative(electronApp, ownerId, guest.url)
    if (!hidden || hidden.owner.visible || !Number.isSafeInteger(hidden.pid) || hidden.pid <= 0) {
      throw new Error(
        `Hidden owner pid=${hidden?.pid} launcherPid=${electronApp.process().pid} visible=${hidden?.owner.visible}`
      )
    }
    await rendezvous.request(
      'ready-to-show',
      { ...hidden, samples: [], diagnosticMarkers: [] },
      testInfo
    )
    try {
      await electronApp.evaluate(({ BrowserWindow }, id) => {
        const owner = BrowserWindow.fromId(id)
        if (!owner || owner.isDestroyed() || owner.isVisible()) {
          throw new Error('Owned show precondition changed')
        }
        owner.show()
      }, ownerId)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('Resulting promise was garbage collected')
      ) {
        throw error
      }
      // Reconcile the single permitted effect; never repeat show after an ambiguous result.
      const observed = await readNative(electronApp, ownerId, guest.url)
      if (
        !observed ||
        !observed.owner.visible ||
        observed.pid !== hidden.pid ||
        observed.hwnd !== hidden.hwnd ||
        observed.nativeGuest.guestId !== hidden.nativeGuest.guestId ||
        observed.owner.rendererId !== hidden.owner.rendererId
      ) {
        throw error
      }
      await testInfo.attach('owned-show-reconciled.json', {
        body: JSON.stringify({ error: error.message, hidden, observed, showRepeated: false }),
        contentType: 'application/json'
      })
    }
    await expect
      .poll(async () => (await readNative(electronApp, ownerId, guest.url))?.owner.visible)
      .toBe(true)
    await expect
      .poll(
        async () => {
          const sample = await readNative(electronApp, ownerId, guest.url)
          if (!sample) {
            return null
          }
          return (
            await readFallback(
              orcaPage,
              pageId,
              sample.nativeGuest.content,
              sample.nativeGuest.zoom,
              fallbackDiagnostics
            )
          )?.proofRgb
        },
        { timeout: 10_000 }
      )
      .toEqual([255, 0, 0])
    const hintSample = await readNative(electronApp, ownerId, guest.url)
    if (!hintSample) {
      throw new Error('Hint native guest missing')
    }
    const hintFallback = await readFallback(
      orcaPage,
      pageId,
      hintSample.nativeGuest.content,
      hintSample.nativeGuest.zoom,
      fallbackDiagnostics
    )
    if (!hintFallback) {
      throw new Error('Real initial occlusion fallback missing')
    }
    await retainFallback(hintFallback, 'initial-draw-hint', testInfo)
    await drawHint.getByRole('button', { name: 'Got it', exact: true }).click()
    await expect(drawHint).toBeHidden()
    const rendererMarker = await installMarker(orcaPage, false, pageId)
    const initial = await readNative(electronApp, ownerId, guest.url)
    if (
      !initial ||
      initial.pid !== hidden.pid ||
      initial.hwnd !== hidden.hwnd ||
      initial.nativeGuest.guestId !== hidden.nativeGuest.guestId
    ) {
      throw new Error('Initial native identity changed after show permission')
    }
    const guestId = initial.nativeGuest.guestId
    let priorGuestScreenRect: ScreenRect | undefined
    const capture = async (
      stage: Exclude<ComposedStage, 'ready-to-show'>,
      modalMarker?: Awaited<ReturnType<typeof installMarker>>,
      nativeDiscriminator?: NativeDiscriminator
    ) => {
      const snapshot = await readNative(electronApp, ownerId, guest.url)
      if (
        !snapshot ||
        snapshot.nativeGuest.guestId !== guestId ||
        snapshot.pid !== initial.pid ||
        snapshot.hwnd !== initial.hwnd
      ) {
        throw new Error('Owned native identity changed')
      }
      if (
        !snapshot.owner.visible ||
        snapshot.nativeGuest.visible !== (stage !== 'modal-blocked') ||
        snapshot.nativeGuest.loading ||
        snapshot.nativeGuest.title !== 'Composed synthetic guest'
      ) {
        throw new Error('Composed stage readiness changed')
      }
      if ((stage === 'direct-native' || stage === 'native-restored') && !nativeDiscriminator) {
        throw new Error('Native versus fallback discriminator missing')
      }
      const markers = modalMarker ? [rendererMarker, modalMarker] : [rendererMarker]
      const samples = await electronApp.evaluate(
        ({ screen }, args) => {
          const samples: PixelSample[] = []
          const point = (x: number, y: number) =>
            screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) })
          for (const marker of args.markers) {
            const physical = point(
              args.snapshot.owner.contentBounds.x +
                (marker.bounds.x + marker.bounds.width / 2) * args.snapshot.owner.zoom,
              args.snapshot.owner.contentBounds.y +
                (marker.bounds.y + marker.bounds.height / 2) * args.snapshot.owner.zoom
            )
            samples.push({
              name: marker.id,
              screenX: physical.x,
              screenY: physical.y,
              rgb: marker.rgb,
              tolerance: 12,
              radius: 2,
              role: marker.role === 'modal' ? 'modal' : 'renderer'
            })
          }
          if (args.stage === 'direct-native' || args.stage === 'native-restored') {
            for (const patch of [
              { name: 'proof', x: 92, rgb: args.proofRgb },
              { name: 'green', x: 240, rgb: [0, 255, 0] },
              { name: 'blue', x: 388, rgb: [0, 0, 255] }
            ]) {
              const physical = point(
                args.snapshot.owner.contentBounds.x +
                  args.snapshot.nativeGuest.container.x +
                  args.snapshot.nativeGuest.content.x +
                  patch.x * args.snapshot.nativeGuest.zoom,
                args.snapshot.owner.contentBounds.y +
                  args.snapshot.nativeGuest.container.y +
                  args.snapshot.nativeGuest.content.y +
                  67 * args.snapshot.nativeGuest.zoom
              )
              samples.push({
                name: `guest-${patch.name}`,
                screenX: physical.x,
                screenY: physical.y,
                rgb: patch.rgb,
                tolerance: 12,
                radius: 2,
                role: 'guest'
              })
            }
          }
          return samples
        },
        {
          snapshot,
          markers,
          stage,
          proofRgb: nativeDiscriminator?.expectedNativeProofRgb ?? [255, 0, 0]
        }
      )
      for (const sample of samples) {
        expect(Number.isInteger(sample.screenX) && Number.isInteger(sample.screenY)).toBe(true)
        if (sample.role === 'guest' || sample.role === 'modal') {
          const clip =
            stage === 'modal-blocked' ? priorGuestScreenRect : snapshot.nativeGuest.screenRect
          if (
            !clip ||
            sample.screenX - 2 <= clip.x ||
            sample.screenY - 2 <= clip.y ||
            sample.screenX + 2 >= clip.x + clip.width ||
            sample.screenY + 2 >= clip.y + clip.height
          ) {
            throw new Error('Pixel sample is outside the former native guest clip')
          }
        }
      }
      await rendezvous.request(
        stage,
        {
          ...snapshot,
          samples,
          priorGuestScreenRect,
          diagnosticMarkers: markers,
          nativeDiscriminator
        },
        testInfo
      )
      return snapshot
    }
    const captureNative = async (
      stage: 'direct-native' | 'native-restored',
      rgb: number[],
      frozenFallback?: NonNullable<Awaited<ReturnType<typeof readFallback>>>
    ) => {
      const sample = await readNative(electronApp, ownerId, guest.url)
      if (!sample || sample.nativeGuest.guestId !== guestId || !sample.nativeGuest.visible) {
        throw new Error('Visible native guest missing before discriminator')
      }
      const before = await readFallback(
        orcaPage,
        pageId,
        sample.nativeGuest.content,
        sample.nativeGuest.zoom,
        fallbackDiagnostics
      )
      if (
        !before ||
        (frozenFallback && before.source !== frozenFallback.source) ||
        Math.max(...before.proofRgb.map((channel, index) => Math.abs(channel - rgb[index]))) <= 24
      ) {
        throw new Error('Fallback is absent, changed, or cannot discriminate native paint')
      }
      const fallback = await retainFallback(before, stage, testInfo)
      const nativeDomProof = await nativeProof(
        electronApp,
        ownerId,
        guestId,
        guest.url,
        `${pageId}:${stage}:${controlToken}`,
        rgb,
        true
      )
      const result = await capture(stage, undefined, {
        fallback,
        fallbackSrcShaBefore: before.sourceSha,
        expectedNativeProofRgb: rgb,
        nativeDomProof
      })
      const after = await readFallback(
        orcaPage,
        pageId,
        sample.nativeGuest.content,
        sample.nativeGuest.zoom,
        fallbackDiagnostics
      )
      if (
        !after ||
        before.source !== after.source ||
        before.sourceSha !== after.sourceSha ||
        before.sha256 !== after.sha256
      ) {
        throw new Error('Renderer fallback changed across native compositor capture')
      }
      const nativeDomProofAfter = await nativeProof(
        electronApp,
        ownerId,
        guestId,
        guest.url,
        nativeDomProof.token,
        rgb,
        false
      )
      expect(nativeDomProofAfter).toEqual(nativeDomProof)
      await rendezvous.discriminatorAfter(
        stage,
        {
          fallbackSrcShaBefore: before.sourceSha,
          fallbackSrcShaAfter: after.sourceSha,
          fallbackUnchanged: true,
          nativeDomProofAfter,
          expectedNativeProofRgb: rgb
        },
        testInfo
      )
      return result
    }
    await expect
      .poll(async () => {
        const sample = await readNative(electronApp, ownerId, guest.url)
        return sample?.owner.visible && sample.nativeGuest.visible
      })
      .toBe(true)
    expect(await orcaPage.locator('[role="dialog"], [data-slot="popover-content"]').count()).toBe(0)
    const direct = await captureNative('direct-native', [173, 37, 91])
    priorGuestScreenRect = direct.nativeGuest.screenRect
    await orcaPage.evaluate(() => window.__store?.getState().openModal('add-repo'))
    const dialog = orcaPage.getByRole('dialog', { name: 'Add a project', exact: true })
    await expect(dialog).toBeVisible()
    await expect(orcaPage.locator('[data-slot="dialog-overlay"][data-state="open"]')).toBeVisible()
    await expect
      .poll(async () => (await readNative(electronApp, ownerId, guest.url))?.nativeGuest.visible)
      .toBe(false)
    await dialog.evaluate(async (element) => {
      const deadline = performance.now() + 2_500
      let prior = ''
      let stable = 0
      while (performance.now() < deadline) {
        const ancestors: Element[] = []
        for (let current: Element | null = element; current; current = current.parentElement) {
          ancestors.push(current)
        }
        const animating = ancestors.some((ancestor) =>
          ancestor.getAnimations().some((animation) => animation.playState === 'running')
        )
        const rect = element.getBoundingClientRect()
        const bounds = JSON.stringify([rect.x, rect.y, rect.width, rect.height])
        const opaque = ancestors.every(
          (ancestor) => Number(getComputedStyle(ancestor).opacity) === 1
        )
        stable = !animating && opaque && bounds === prior ? stable + 1 : 0
        if (stable >= 3) {
          return
        }
        prior = bounds
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('Dialog entrance did not settle within the bounded capture phase')
    })
    const modalMarker = await installMarker(orcaPage, true, pageId)
    await capture('modal-blocked', modalMarker)
    await expect
      .poll(
        async () => {
          const sample = await readNative(electronApp, ownerId, guest.url)
          if (!sample) {
            return null
          }
          return (
            await readFallback(
              orcaPage,
              pageId,
              sample.nativeGuest.content,
              sample.nativeGuest.zoom,
              fallbackDiagnostics
            )
          )?.proofRgb
        },
        { timeout: 10_000 }
      )
      .toEqual([173, 37, 91])
    const modalSample = await readNative(electronApp, ownerId, guest.url)
    if (!modalSample) {
      throw new Error('Modal native guest missing')
    }
    const modalFallback = await readFallback(
      orcaPage,
      pageId,
      modalSample.nativeGuest.content,
      modalSample.nativeGuest.zoom,
      fallbackDiagnostics
    )
    if (!modalFallback) {
      throw new Error('Current modal fallback missing')
    }
    await retainFallback(modalFallback, 'modal-current', testInfo)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(orcaPage.locator('[data-slot="dialog-overlay"][data-state="open"]')).toBeHidden()
    await expect
      .poll(async () => (await readNative(electronApp, ownerId, guest.url))?.nativeGuest.visible)
      .toBe(true)
    await captureNative('native-restored', [19, 203, 127], modalFallback)
  } catch (error) {
    failed = true
    primaryError = error
  }
  const cleanup = async (name: string, action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      cleanupErrors.push(`${name}: ${String(error)}`)
    }
  }
  await cleanup('close exact browser tab', async () => {
    if (browserTabId) {
      await orcaPage.evaluate((id) => window.__store?.getState().closeBrowserTab(id), browserTabId)
    }
  })
  await cleanup('native guest destruction', async () => {
    await expect
      .poll(() => readNative(electronApp, ownerId, guest.url), { timeout: 5_000 })
      .toBeNull()
    await expect
      .poll(
        () =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents.getAllWebContents().some((contents) => contents.getURL() === url),
            guest.url
          ),
        { timeout: 5_000 }
      )
      .toBe(false)
  })
  await cleanup('hide exact owner', () =>
    electronApp.evaluate(({ BrowserWindow }, id) => {
      const owner = BrowserWindow.fromId(id)
      if (!owner || owner.isDestroyed()) {
        throw new Error('Owned hide target unavailable')
      }
      owner.hide()
      if (owner.isVisible()) {
        throw new Error('Owned window remained visible')
      }
    }, ownerId)
  )
  await cleanup('guest server close', guest.close)
  await cleanup('cleanup receipt', () =>
    testInfo.attach('composed-cleanup.json', {
      body: JSON.stringify({ ownerId, browserTabId, cleanupErrors, fallbackDiagnostics }, null, 2),
      contentType: 'application/json'
    })
  )
  if (failed) {
    throw primaryError
  }
  if (cleanupErrors.length) {
    throw new Error(cleanupErrors.join('\n'))
  }
})

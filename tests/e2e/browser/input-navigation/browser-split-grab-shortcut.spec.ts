// STA-3319 / STA-8147: Cmd/Ctrl+C arms element grab only in the focused split, and never
// while text is selected elsewhere in the window (that press is a copy).

import 'node:crypto'
import 'node:fs'
import 'node:os'
import 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import '../../terminal/input/terminal'

import '../../terminal/lifecycle/terminal-pty-readiness'

import {
  browserOverlay,
  createBrowserSplit,
  guestModifier,
  pressKeyInBrowserGuest,
  type GuestModifier
} from './browser-split-fixture'
import { waitForGuestUrl } from './browser-split-guest-probes'
import {
  startBrowserSplitPageServer,
  type BrowserSplitPageServer
} from './browser-split-page-server'

function grabBanner(page: Page, browserTabId: string) {
  return browserOverlay(page, browserTabId).getByText(/Click or hover an element|Grab failed/)
}

async function readGuestGrab(page: Page, browserTabId: string, expression: string) {
  return page.evaluate(
    async ({ tabId, script }) => {
      const webview = document.querySelector<Electron.WebviewTag>(
        `[data-browser-overlay-tab-id="${tabId}"] webview`
      )
      return webview ? Boolean(await webview.executeJavaScript(script)) : false
    },
    { tabId: browserTabId, script: expression }
  )
}

// Hover like a user: the banner shows before the picker arms, which records hover a frame later.
async function hoverGuestGrabTarget(page: Page, browserTabId: string, x: number, y: number) {
  await expect
    .poll(() => readGuestGrab(page, browserTabId, 'Boolean(window.__orcaGrab?.onPick)'))
    .toBe(true)
  await page.evaluate(
    async ({ tabId, x, y }) => {
      const webview = document.querySelector<Electron.WebviewTag>(
        `[data-browser-overlay-tab-id="${tabId}"] webview`
      )
      await webview?.sendInputEvent({ type: 'mouseMove', x, y })
    },
    { tabId: browserTabId, x, y }
  )
  await expect
    .poll(() =>
      readGuestGrab(page, browserTabId, 'Boolean(window.__orcaGrab?.getCurrentElement())')
    )
    .toBe(true)
}

async function readClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

async function writeClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

/** Arms grab from the pane's toolbar: the presence check that makes a missing banner meaningful. */

/** Turns the terminal split into a native chat view over a seeded Claude transcript. */

test.describe('browser split grab shortcut', () => {
  // Why: these tests share the system clipboard, so keep them on one worker.
  test.describe.configure({ mode: 'default' })

  let server: BrowserSplitPageServer
  let savedClipboard: string | null = null

  test.beforeEach(async ({ electronApp, orcaPage }) => {
    server = await startBrowserSplitPageServer()
    // Why: the copy assertions read the real system clipboard; put the user's text back after.
    savedClipboard = await readClipboard(electronApp)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async ({ electronApp }) => {
    if (savedClipboard !== null) {
      await writeClipboard(electronApp, savedClipboard)
    }
    await server.close()
  })

  test('escape typed in the page exits grab, the copy toast and find', async ({ orcaPage }) => {
    const fixture = await createBrowserSplit(orcaPage, {
      first: server.pageUrl('a', 1),
      second: server.pageUrl('b', 1, 'localhost')
    })
    await waitForGuestUrl(orcaPage, fixture.firstBrowserTabId, server.pageUrl('a', 1))
    const overlay = browserOverlay(orcaPage, fixture.firstBrowserTabId)
    const pressInGuest = (keyCode: string, modifiers: GuestModifier[] = []): Promise<void> =>
      pressKeyInBrowserGuest(
        orcaPage,
        fixture.firstBrowserTabId,
        fixture.firstBrowserPageId,
        keyCode,
        modifiers
      )

    await pressInGuest('C', [guestModifier])
    await expect(grabBanner(orcaPage, fixture.firstBrowserTabId)).toBeVisible()
    await pressInGuest('Escape')
    await expect(grabBanner(orcaPage, fixture.firstBrowserTabId)).toBeHidden()

    // Why: a click-copy rearms the picker when its toast closes; outlasting the toast proves Escape ended it.
    await pressInGuest('C', [guestModifier])
    await expect(grabBanner(orcaPage, fixture.firstBrowserTabId)).toBeVisible()
    await hoverGuestGrabTarget(orcaPage, fixture.firstBrowserTabId, 60, 30)
    await orcaPage.evaluate(async (browserTabId) => {
      const webview = document.querySelector<Electron.WebviewTag>(
        `[data-browser-overlay-tab-id="${browserTabId}"] webview`
      )
      await webview?.sendInputEvent({
        type: 'mouseDown',
        x: 60,
        y: 30,
        button: 'left',
        clickCount: 1
      })
      await webview?.sendInputEvent({
        type: 'mouseUp',
        x: 60,
        y: 30,
        button: 'left',
        clickCount: 1
      })
    }, fixture.firstBrowserTabId)
    await expect(overlay.getByText('Copied').first()).toBeVisible()
    await pressInGuest('Escape')
    await expect(overlay.getByText('Copied').first()).toBeHidden()
    await expect(grabBanner(orcaPage, fixture.firstBrowserTabId)).toBeHidden()

    await pressInGuest('F', [guestModifier])
    const findInput = overlay.getByPlaceholder('Find in page...')
    await expect(findInput).toBeVisible()
    await pressInGuest('Escape')
    await expect(findInput).toBeHidden()
  })
})

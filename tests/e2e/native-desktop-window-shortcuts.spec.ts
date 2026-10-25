import { expect, test } from './helpers/orca-app'
import {
  createTerminalBrowserSplit,
  guestModifier,
  waitForBrowserGuestRegistration
} from './helpers/browser-split-fixture'
import { waitForGuestIdle } from './helpers/browser-split-guest-probes'
import { waitForSessionReady } from './helpers/store'
import { nativeDesktopPages } from './helpers/native-desktop-window'

for (const custom of [false, true]) {
  test(`${custom ? 'custom' : 'default'} New Window chord in a browser guest opens once and consumes repeats`, async ({
    electronApp,
    orcaPage
  }) => {
    test.setTimeout(120_000)
    if (custom) {
      await orcaPage.evaluate(() =>
        window.__store?.getState().setKeybindingOverride('window.new', ['Mod+Alt+Shift+W'])
      )
    }
    const browser = await createTerminalBrowserSplit(orcaPage)
    await waitForGuestIdle(orcaPage, browser.browserTabId)
    await waitForBrowserGuestRegistration(orcaPage, browser.browserTabId, browser.browserPageId)
    const guestId = await orcaPage.evaluate((tabId) => {
      const guest = document.querySelector<Electron.WebviewTag>(
        `[data-browser-overlay-tab-id="${tabId}"] webview`
      )
      if (!guest) {
        throw new Error('Missing shortcut guest')
      }
      guest.focus()
      return guest.getWebContentsId()
    }, browser.browserTabId)
    const known = new Set(nativeDesktopPages(electronApp))
    const observed = await electronApp.evaluate(
      async ({ webContents }, args) => {
        const guest = webContents.fromId(args.guestId)
        if (!guest) {
          throw new Error('Missing shortcut guest WebContents')
        }
        const inputs: { repeat: boolean; prevented: boolean }[] = []
        const processed = Promise.withResolvers<void>()
        const record = (event: Electron.Event, input: Electron.Input) => {
          if (input.type !== 'keyDown') {
            return
          }
          if (input.key.toLowerCase() === 'z') {
            processed.resolve()
          } else {
            inputs.push({ repeat: input.isAutoRepeat, prevented: event.defaultPrevented })
          }
        }
        guest.on('before-input-event', record)
        const timer = setTimeout(() => processed.reject(new Error('Guest input stalled')), 10_000)
        try {
          const keyCode = args.custom ? 'W' : 'N'
          const modifiers: Electron.KeyboardInputEvent['modifiers'] = [args.modifier, 'alt']
          if (args.custom) {
            modifiers.push('shift')
          }
          guest.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
          for (let repeat = 0; repeat < 3; repeat += 1) {
            guest.sendInputEvent({
              type: 'keyDown',
              keyCode,
              modifiers: [...modifiers, 'isAutoRepeat']
            })
          }
          guest.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
          guest.sendInputEvent({ type: 'keyDown', keyCode: 'Z' })
          guest.sendInputEvent({ type: 'keyUp', keyCode: 'Z' })
          await processed.promise
          return inputs
        } finally {
          clearTimeout(timer)
          guest.off('before-input-event', record)
        }
      },
      { guestId, custom, modifier: guestModifier }
    )
    expect(observed).toEqual([
      { repeat: false, prevented: true },
      { repeat: true, prevented: true },
      { repeat: true, prevented: true },
      { repeat: true, prevented: true }
    ])
    await expect
      .poll(() => nativeDesktopPages(electronApp).filter((page) => !known.has(page)).length)
      .toBe(1)
    const opened = nativeDesktopPages(electronApp).find((page) => !known.has(page))
    if (!opened) {
      throw new Error('New Window shortcut did not open a window')
    }
    await opened.waitForFunction(() => Boolean(window.__store))
    await waitForSessionReady(opened)
    await expect(opened.locator('[data-worktree-sidebar]')).toBeVisible()
    expect(nativeDesktopPages(electronApp).filter((page) => !known.has(page))).toHaveLength(1)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      )
    ).toBe(true)
  })
}

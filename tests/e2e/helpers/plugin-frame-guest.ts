import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

/** A desktop plugin frame: an isolated `<webview>` guest titled with the panel or editor title. */
export function pluginGuest(page: Page, title: string): Locator {
  return page.locator(`webview[title="${title}"]`)
}

/** Runs `source` in the guest's main world and returns its JSON-serializable result. */
export async function evalInGuest<T>(guest: Locator, source: string): Promise<T> {
  // Why unchecked: callers pass expressions whose result shape they assert on.
  const result: T = await guest.evaluate(
    (webview: Electron.WebviewTag, script: string) => webview.executeJavaScript(script),
    source
  )
  return result
}

/**
 * Resolves once the guest's document has finished loading. Polled, not event-driven: the panel can
 * remount its webview while this waits, and a listener on the old element would never fire.
 */
export async function waitForGuestReady(guest: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        guest.evaluate((webview: Electron.WebviewTag) => {
          try {
            return !webview.isLoading() && webview.getURL() !== ''
          } catch {
            // Not attached yet.
            return false
          }
        }),
      { timeout: 15_000 }
    )
    .toBe(true)
}

/** Focuses `selector` inside the guest so real keyboard input from the page reaches it. */
export async function focusInGuest(guest: Locator, selector: string): Promise<void> {
  // Why ready first, then retried as one step: under load the guest can still be attaching, or
  // remount, and executeJavaScript throws until its dom-ready.
  await waitForGuestReady(guest)
  const target = `document.querySelector(${JSON.stringify(selector)})`
  await expect
    .poll(async () => {
      try {
        await guest.evaluate((webview: Electron.WebviewTag) => webview.focus())
        await evalInGuest(guest, `${target}?.focus()`)
        // Page keyboard input reaches the guest once the host has moved focus onto the webview.
        return (await guest.evaluate((webview) => webview.ownerDocument.activeElement === webview))
          ? await evalInGuest<boolean>(guest, `document.activeElement === ${target}`)
          : false
      } catch {
        return false
      }
    })
    .toBe(true)
}

/**
 * Clicks `selector` with real (trusted, activating) mouse input delivered to the guest's own
 * WebContents. Why not page.mouse: on Linux headless (xvfb) host-window clicks never reach a
 * <webview> guest, and host overlays such as tooltips can eat them on any platform.
 */
export async function clickInGuest(guest: Locator, selector: string): Promise<void> {
  const point = await evalInGuest<{ x: number; y: number } | null>(
    guest,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`
  )
  if (!point) {
    throw new Error(`no ${selector} in the plugin guest`)
  }
  await guest.evaluate((webview: Electron.WebviewTag, { x, y }) => {
    webview.sendInputEvent({ type: 'mouseMove', x, y })
    webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }, point)
}

/** Like evalInGuest, but null while the guest is still attaching, for `expect.poll`. */
export async function readInGuest<T>(guest: Locator, source: string): Promise<T | null> {
  try {
    return await evalInGuest<T>(guest, source)
  } catch {
    return null
  }
}

/** The CSP the guest's document was served with (a response header, not a `<meta>`). */
export function readGuestCsp(guest: Locator): Promise<string | null> {
  return evalInGuest<string | null>(
    guest,
    `fetch(location.href).then((response) => response.headers.get('content-security-policy'))`
  )
}

/** The guest's WebContents id, for addressing exactly this guest from the main process. */
export function guestWebContentsId(guest: Locator): Promise<number> {
  return guest.evaluate((webview: Electron.WebviewTag) => webview.getWebContentsId())
}

/** Isolated frames are off by default until the flip; guest-path specs turn them on per launch. */
export const ISOLATED_FRAMES_E2E = { orcaAppExtraEnv: { ORCA_PLUGIN_ISOLATED_FRAMES: '1' } }

import type { ElectronApplication, Page } from '@stablyai/playwright-test'

export type ClientGuestState = {
  focusedElement: string | null
  keyboardValue: string
  marker: string | null
  pointerValue: string | null
}

export async function readScreencastSubscribeCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __remoteBrowserScreencastObserver?: { snapshot: () => { subscribeCount: number } }
        }
      ).__remoteBrowserScreencastObserver?.snapshot().subscribeCount ?? 0
  )
}

export async function readOwnedPageUrls(
  app: ElectronApplication,
  urlPrefix: string
): Promise<string[]> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .map((contents) => contents.getURL())
        .filter((url) => url.startsWith(prefix)),
    urlPrefix
  )
}

export async function readClientGuestState(
  page: Page,
  urlPrefix: string
): Promise<ClientGuestState | null> {
  return page.evaluate(async (prefix) => {
    for (const candidate of document.querySelectorAll('webview')) {
      const webview = candidate as Electron.WebviewTag
      if (!webview.getURL().startsWith(prefix)) {
        continue
      }
      return webview.executeJavaScript(`({
        focusedElement: document.activeElement?.id ?? null,
        keyboardValue: document.querySelector('#keyboard-target')?.value ?? '',
        marker: document.querySelector('#marker')?.textContent ?? null,
        pointerValue: document.querySelector('#pointer-target')?.textContent ?? null
      })`) as Promise<ClientGuestState>
    }
    return null
  }, urlPrefix)
}

export async function sendClientGuestKeyboardInput(
  page: Page,
  urlPrefix: string,
  text: string
): Promise<void> {
  await page.evaluate(
    async ({ prefix, text }) => {
      const webview = [...document.querySelectorAll('webview')].find((candidate) =>
        (candidate as Electron.WebviewTag).getURL().startsWith(prefix)
      ) as Electron.WebviewTag | undefined
      if (!webview) {
        throw new Error('client-hosted guest unavailable for keyboard input')
      }
      for (const character of text) {
        await webview.sendInputEvent({ type: 'char', keyCode: character })
      }
    },
    { prefix: urlPrefix, text }
  )
}

export async function sendClientGuestPointerInput(
  page: Page,
  urlPrefix: string,
  selector: string
): Promise<void> {
  await page.evaluate(
    async ({ prefix, selector }) => {
      const webview = [...document.querySelectorAll('webview')].find((candidate) =>
        (candidate as Electron.WebviewTag).getURL().startsWith(prefix)
      ) as Electron.WebviewTag | undefined
      if (!webview) {
        throw new Error('client-hosted guest unavailable for pointer input')
      }
      const point = (await webview.executeJavaScript(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect()
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
      })()`)) as { x: number; y: number } | null
      if (!point) {
        throw new Error(`client-hosted guest target unavailable: ${selector}`)
      }
      await webview.sendInputEvent({ type: 'mouseMove', ...point })
      await webview.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      await webview.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    },
    { prefix: urlPrefix, selector }
  )
}

// Measure relaunch start through the first fully drawn restored terminal frame, including DevTools attach and a warm daemon.
// Compare only like-for-like runs; install at DOM ready and fail if drawing already happened.

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { WebContents } from 'electron'

type FirstDrawnState = { drawnAtInstall: boolean; drawnAt: number | null }

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __layoutFirstDrawn?: FirstDrawnState
  }
}

/** Runs in the window, serialized: it can use nothing outside its own body. */
function watchFirstDrawn(paneCount: number): void {
  const drawn = (): boolean => {
    const surface = Array.from(
      document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')
    ).find((element) => element.getBoundingClientRect().width > 0 && element.querySelector('.pane'))
    const panes = Array.from(surface?.querySelectorAll('.pane[data-leaf-id]') ?? [])
    return panes.length === paneCount && panes.every((pane) => pane.querySelector('.xterm'))
  }
  const state: FirstDrawnState = { drawnAtInstall: drawn(), drawnAt: null }
  window.__layoutFirstDrawn = state
  const tick = (): void => {
    if (drawn()) {
      state.drawnAt = Date.now()
      return
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** Call from `beforeFirstWindow`: covers a window that already exists and one created later. */
export function installFirstDrawnWatch(app: ElectronApplication, paneCount: number): Promise<void> {
  const source = `(${watchFirstDrawn.toString()})(${paneCount})`
  return app.evaluate(({ app, webContents }, script) => {
    const install = (contents: WebContents): void => {
      if (contents.getType() !== 'window') {
        return
      }
      const run = (): void => {
        void contents.executeJavaScript(script)
      }
      if (contents.isLoading() || !contents.getURL()) {
        contents.once('dom-ready', run)
      } else {
        run()
      }
    }
    webContents.getAllWebContents().forEach(install)
    app.once('web-contents-created', (_event, contents) => install(contents))
  }, source)
}

export async function readFirstDrawn(
  app: ElectronApplication,
  page: Page
): Promise<{ processStartedAt: number; drawnAt: number }> {
  const handle = await page.waitForFunction(
    () => {
      const state = window.__layoutFirstDrawn
      return state?.drawnAt ? state : null
    },
    null,
    { timeout: 120_000 }
  )
  const state = await handle.jsonValue()
  if (!state || state.drawnAtInstall || state.drawnAt === null) {
    throw new Error('first-drawn watch was installed after the restored panes drew')
  }
  return {
    processStartedAt: await app.evaluate(() => performance.timeOrigin),
    drawnAt: state.drawnAt
  }
}

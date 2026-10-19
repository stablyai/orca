/**
 * Time to first drawn after a relaunch: from the main process's start to the first animation
 * frame in which the restored active tab shows all its panes with a terminal in each. The span
 * includes the test harness attaching DevTools before the first window, and every relaunch keeps
 * the PTY daemon warm, so compare it only with itself, not with a user's cold start. The watch is
 * installed by main as soon as the window's DOM is ready and fails if the panes drew earlier.
 */

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

/** Epoch ms of the main process's start and of first drawn. */
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

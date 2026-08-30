/**
 * Regression guard for "the first press on the tab strip selects text instead
 * of moving the window".
 *
 * The tab strip stands in for a native titlebar, so it carries the window drag
 * region. #6301 gated that region on terminal focus: while xterm owned focus
 * every top-chrome drag surface flipped to `-webkit-app-region: no-drag`, so
 * the click that releases terminal zoom ownership would reach the renderer.
 *
 * Electron hit-tests app-region at mousedown, so the press that flipped the
 * attribute back was itself consumed by the renderer — it started a text
 * selection, and the window only moved on a second press.
 *
 * The invariant: chrome drag surfaces stay draggable no matter who owns focus.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import { focusActiveTerminalInput, waitForActiveTerminalManager } from './helpers/terminal'

const DRAG_SURFACE_SELECTORS = ['[data-window-drag-strip="true"]', '.titlebar-left']

test.describe('Window drag with terminal focus', () => {
  test('chrome drag surfaces stay draggable while xterm owns focus', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await focusActiveTerminalInput(orcaPage)

    // Why: assert the focus state the old rule keyed on, so a future change that
    // stops publishing terminal focus can't make this test vacuously pass.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() =>
            document.documentElement.hasAttribute('data-regular-terminal-input-focused')
          ),
        { timeout: 10_000, message: 'xterm never took input focus' }
      )
      .toBe(true)

    const dragRegions = await orcaPage.evaluate((selectors) => {
      return selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) {
          return { selector, appRegion: 'missing', userSelect: 'missing' }
        }
        const style = getComputedStyle(element)
        return {
          selector,
          appRegion: style.getPropertyValue('-webkit-app-region').trim(),
          userSelect: style.userSelect
        }
      })
    }, DRAG_SURFACE_SELECTORS)

    expect(dragRegions).toEqual(
      DRAG_SURFACE_SELECTORS.map((selector) => ({
        selector,
        appRegion: 'drag',
        // Why: the press is only swallowed by the OS caption while the region is
        // draggable; `none` keeps a stray press from starting a selection.
        userSelect: 'none'
      }))
    )
  })
})
